using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

internal static class WindowHelper {
    private static readonly object TargetLock = new object();
    private static long targetHandle;
    private static int targetPid;
    private static bool trackComposer;
    private static string dockTarget = "composer";
    private static int ownerPid;
    private static StreamWriter output;
    private static bool ParentAlive() { return ownerPid == 0 || CodexStatusbarWindows.IsProcessRunning(ownerPid); }
    private static void Write(string json) { output.WriteLine(json); output.Flush(); }
    private static long Number(string[] args, string key) {
        int index = Array.IndexOf(args, key); long value;
        return index >= 0 && index + 1 < args.Length && long.TryParse(args[index + 1], out value) && value >= 0 ? value : 0;
    }
    [MTAThread]
    public static int Main(string[] args) {
        ownerPid = (int)Math.Min(int.MaxValue, Number(args, "--owner"));
        bool once = Array.IndexOf(args, "--once") >= 0;
        if (!once && ownerPid == 0) return 2;
        try { output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)); } catch { return 3; }
        try { CodexStatusbarWindows.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
        var parentMonitor = new Thread(delegate() {
            while (ParentAlive()) Thread.Sleep(1000);
            Environment.Exit(0);
        });
        parentMonitor.IsBackground = true; parentMonitor.Start();
        try {
            if (once && Number(args, "--layer-handle") != 0) Write(CodexStatusbarWindows.InspectOverlay(Number(args, "--layer-handle"), Number(args, "--above-handle")));
            else if (Array.IndexOf(args, "--title") >= 0) RunTitles();
            else RunGeometry(once, Number(args, "--probe-handle"));
            return 0;
        } catch { return 1; }
    }
    private static void RunGeometry(bool once, long probe) {
        string previous = null; DateTime lastOutput = DateTime.MinValue;
        do {
            string sample = CodexStatusbarWindows.Sample(ownerPid, once ? probe : 0);
            DateTime now = DateTime.UtcNow;
            if (sample != previous || (now - lastOutput).TotalSeconds >= 2) { Write(sample); previous = sample; lastOutput = now; }
            if (!once) Thread.Sleep(sample.Contains("\"visible\":true") || sample.Contains("\"ownForeground\":true") ? 250 : 1000);
        } while (!once && ParentAlive());
    }
    private static void RunTitles() {
        var reader = new Thread(delegate() {
            var parser = new JavaScriptSerializer(); parser.MaxJsonLength = 4096;
            try {
                var inputStream = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                string line;
                while ((line = inputStream.ReadLine()) != null) {
                    try {
                        var input = parser.Deserialize<Dictionary<string, object>>(line);
                        long handle = Convert.ToInt64(input["handle"]); int pid = Convert.ToInt32(input["processId"]);
                        bool composer = input.ContainsKey("composer") && input["composer"] is bool && (bool)input["composer"];
                        string dock = input.ContainsKey("dockTarget") && Convert.ToString(input["dockTarget"]) == "titlebar" ? "titlebar" : "composer";
                        lock (TargetLock) { targetHandle = Math.Max(0, handle); targetPid = Math.Max(0, pid); trackComposer = composer; dockTarget = dock; }
                    } catch { }
                }
            } catch { }
            Environment.Exit(0);
        });
        reader.IsBackground = true; reader.Start();
        var serializer = new JavaScriptSerializer();
        string previous = null; DateTime lastOutput = DateTime.MinValue;
        while (ParentAlive()) {
            long handle; int pid; bool composerEnabled; string dock;
            lock (TargetLock) { handle = targetHandle; pid = targetPid; composerEnabled = trackComposer; dock = dockTarget; }
            string title = null; bool unavailable = false;
            object composer = null;
            if (handle != 0 && pid != 0) {
                try {
                    uint actualPid; CodexStatusbarWindows.GetWindowThreadProcessId(new IntPtr(handle), out actualPid);
                    if (actualPid != pid || !CodexStatusbarWindows.IsCodexProcess(actualPid)) throw new InvalidOperationException();
                    var element = AutomationElement.FromHandle(new IntPtr(handle));
                    var condition = new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document);
                    var document = element.FindFirst(TreeScope.Descendants, condition);
                    if (document != null) title = document.Current.Name;
                    if (title != null && title.Length > 2048) title = null;
                    if (composerEnabled) { try { composer = dock == "titlebar" ? ReadTitlebar(element, new IntPtr(handle)) : ReadComposer(element); } catch { composer = null; } }
                } catch { unavailable = true; }
            }
            lock (TargetLock) { if (handle != targetHandle || pid != targetPid || composerEnabled != trackComposer || dock != dockTarget) continue; }
            string sample = serializer.Serialize(new { handle = handle, processId = pid, documentTitle = title, idle = handle == 0, unavailable = unavailable, composer = composer, dockTarget = dock });
            DateTime now = DateTime.UtcNow;
            if (sample != previous || (now - lastOutput).TotalSeconds >= 2) { Write(sample); previous = sample; lastOutput = now; }
            Thread.Sleep(handle == 0 ? 1000 : 750);
        }
    }
    // Use actual menu/caption control bounds; never infer a slot over window buttons.
    private static object ReadTitlebar(AutomationElement root, IntPtr hwnd) {
        if (CodexStatusbarWindows.IsIconic(hwnd)) return null;
        var host = root.Current.BoundingRectangle;
        if (host.IsEmpty || host.Width < 350 || host.Height < 250) return null;
        var menus = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.MenuBar));
        double left = host.Left, top = 0, bottom = 0; bool menuFound = false;
        for (int i = 0; i < Math.Min(menus.Count, 16); i++) {
            var info = menus[i].Current; var r = info.BoundingRectangle;
            if (info.IsOffscreen || r.IsEmpty || r.Top < host.Top || r.Top > host.Top + 100 || r.Height > 100 || r.Width > host.Width / 2) continue;
            left = Math.Max(left, r.Right); top = r.Top; bottom = r.Bottom; menuFound = true; break;
        }
        if (!menuFound) return null;
        double right = host.Right; int captions = 0;
        var buttons = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ClassNameProperty, "ChromeNodeCaptionButton"));
        for (int i = 0; i < Math.Min(buttons.Count, 12); i++) {
            var info = buttons[i].Current; var r = info.BoundingRectangle;
            if (info.IsOffscreen || r.IsEmpty || r.Top < host.Top || r.Top > bottom || r.Bottom > host.Top + 120 || r.Left < left) continue;
            right = Math.Min(right, r.Left); top = Math.Min(top, r.Top); bottom = Math.Max(bottom, r.Bottom); captions++;
        }
        if (captions < 2) return null;
        double padding = Math.Max(6, (bottom - top) / 6);
        left += padding; right -= padding;
        if (right - left < 200 || bottom - top < 20 || bottom - top > 120) return null;
        return new { x = Math.Ceiling(left), y = Math.Ceiling(top), width = Math.Floor(right) - Math.Ceiling(left), height = Math.Floor(bottom) - Math.Ceiling(top) };
    }
    // Only control classes and bounds are inspected. Never read input Value/Name.
    private static object ReadComposer(AutomationElement root) {
        var edits = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
        object result = null; int matches = 0;
        for (int i = 0; i < Math.Min(edits.Count, 64); i++) {
            var edit = edits[i]; var current = edit.Current;
            if (current.IsOffscreen || !current.IsKeyboardFocusable || !(" " + current.ClassName + " ").Contains(" ProseMirror ")) continue;
            var rect = current.BoundingRectangle;
            var parent = TreeWalker.ControlViewWalker.GetParent(edit);
            if (parent == null) continue;
            var candidate = parent.Current.BoundingRectangle;
            bool threadComposer = false;
            for (int depth = 0; depth < 6 && parent != null; depth++, parent = TreeWalker.ControlViewWalker.GetParent(parent)) {
                if ((parent.Current.ClassName ?? "").Contains("thread-scroll-container")) { threadComposer = true; break; }
            }
            // Chromium may expose an editor's unclipped bounds beyond its container.
            // The composer container includes the toolbar and is the exclusion area.
            if (!threadComposer || candidate.IsEmpty || candidate.Width < 200 || candidate.Height < 20 || rect.IsEmpty || !candidate.IntersectsWith(rect)) continue;
            matches++;
            result = new { x = candidate.X, y = candidate.Y, width = candidate.Width, height = candidate.Height };
        }
        return matches == 1 ? result : null;
    }
}
