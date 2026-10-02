param([int]$OverlayProcessId = 0, [switch]$Once, [long]$ProbeWindowHandle = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class CodexStatusbarWindows {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int size);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT rect, int size);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    public static bool IsProcessRunning(int pid) {
        try { using (var process = Process.GetProcessById(pid)) { return !process.HasExited; } }
        catch { return false; }
    }
    public static bool IsCodexProcess(uint pid) {
        try {
            using (var process = Process.GetProcessById((int)pid)) {
                if (process.ProcessName.Equals("Codex", StringComparison.OrdinalIgnoreCase)) return true;
                if (!process.ProcessName.Equals("ChatGPT", StringComparison.OrdinalIgnoreCase)) return false;
                var executable = process.MainModule.FileName;
                return executable.IndexOf("OpenAI.Codex", StringComparison.OrdinalIgnoreCase) >= 0 ||
                    executable.IndexOf("\\Codex\\", StringComparison.OrdinalIgnoreCase) >= 0;
            }
        } catch { return false; }
    }
    public static string Hidden(bool ownForeground = false) {
        var counts = new Dictionary<uint, int>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
            if (!IsWindowVisible(hwnd) || GetWindow(hwnd, 4) != IntPtr.Zero) return true;
            var cls = new StringBuilder(128); GetClassName(hwnd, cls, cls.Capacity);
            if (cls.ToString() != "Chrome_WidgetWin_1") return true;
            var style = GetWindowLongPtr(hwnd, -20).ToInt64();
            if ((style & (0x80L | 0x80000L)) != 0) return true;
            RECT rect; if (!GetWindowRect(hwnd, out rect)) return true;
            if (!IsIconic(hwnd) && (rect.Right - rect.Left < 350 || rect.Bottom - rect.Top < 250)) return true;
            uint candidatePid; GetWindowThreadProcessId(hwnd, out candidatePid);
            if (!IsCodexProcess(candidatePid)) return true;
            counts[candidatePid] = counts.ContainsKey(candidatePid) ? counts[candidatePid] + 1 : 1;
            return true;
        }, IntPtr.Zero);
        uint processId = 0; int count = 0;
        foreach (var pair in counts) { processId = pair.Key; count += pair.Value; }
        if (counts.Count != 1) processId = 0;
        return "{\"visible\":false,\"ownForeground\":" + (ownForeground ? "true" : "false") +
            ",\"processId\":" + processId + ",\"windowCount\":" + count + "}";
    }
    public static string Sample(int ownPid, long probeWindow) {
        var foreground = probeWindow == 0 ? GetForegroundWindow() : new IntPtr(probeWindow);
        uint pid;
        GetWindowThreadProcessId(foreground, out pid);
        if (pid == ownPid) return Hidden(true);
        if (!IsCodexProcess(pid)) return Hidden();
        IntPtr host = IntPtr.Zero;
        long bestArea = 0;
        RECT best = new RECT();
        int windowCount = 0;
        EnumWindows(delegate(IntPtr hwnd, IntPtr data) {
            uint candidatePid;
            GetWindowThreadProcessId(hwnd, out candidatePid);
            if (candidatePid != pid || !IsWindowVisible(hwnd) || IsIconic(hwnd) || GetWindow(hwnd, 4) != IntPtr.Zero) return true;
            var cls = new StringBuilder(128);
            GetClassName(hwnd, cls, cls.Capacity);
            if (cls.ToString() != "Chrome_WidgetWin_1") return true;
            var style = GetWindowLongPtr(hwnd, -20).ToInt64();
            if ((style & (0x80L | 0x80000L)) != 0) return true;
            RECT windowRect;
            if (!GetWindowRect(hwnd, out windowRect)) return true;
            RECT rect;
            // Updated Desktop windows can report stale/tiny DWM frame bounds.
            // Keep the real window rectangle when those bounds are implausible.
            if (DwmGetWindowAttribute(hwnd, 9, out rect, Marshal.SizeOf(typeof(RECT))) != 0 ||
                Math.Abs(rect.Left - windowRect.Left) > 64 || Math.Abs(rect.Top - windowRect.Top) > 64 ||
                Math.Abs(rect.Right - windowRect.Right) > 64 || Math.Abs(rect.Bottom - windowRect.Bottom) > 64)
                rect = windowRect;
            int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
            if (width < 350 || height < 250) return true;
            windowCount++;
            long area = (long)width * height;
            if (hwnd == foreground || (host != foreground && area > bestArea)) { host = hwnd; best = rect; bestArea = area; }
            return true;
        }, IntPtr.Zero);
        if (host == IntPtr.Zero) return Hidden();
        return "{\"visible\":true,\"processId\":" + pid + ",\"windowCount\":" + windowCount + ",\"handle\":" + host.ToInt64() + ",\"x\":" + best.Left + ",\"y\":" + best.Top +
            ",\"width\":" + (best.Right-best.Left) + ",\"height\":" + (best.Bottom-best.Top) + "}";
    }
}
'@
[void][CodexStatusbarWindows]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
$windowPrevious = ''
$lastOutput = [DateTime]::MinValue
$lastTitleAt = [DateTime]::MinValue
$lastTitleHandle = 0
$documentTitle = $null
do {
    if ($OverlayProcessId -ne 0 -and ![CodexStatusbarWindows]::IsProcessRunning($OverlayProcessId)) { break }
    $windowSample = [CodexStatusbarWindows]::Sample($OverlayProcessId, $(if ($Once) { $ProbeWindowHandle } else { 0 }))
    $now = [DateTime]::UtcNow
    $sampleObject = $windowSample | ConvertFrom-Json
    if ($sampleObject.visible) {
        if ($sampleObject.handle -ne $lastTitleHandle -or ($now - $lastTitleAt).TotalMilliseconds -ge 750) {
            $documentTitle = $null
            try {
                $element = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new([long]$sampleObject.handle))
                $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
                $document = $element.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
                if ($document) { $documentTitle = $document.Current.Name }
            } catch { $documentTitle = $null }
            $lastTitleAt = $now
            $lastTitleHandle = $sampleObject.handle
        }
        $sampleObject | Add-Member -NotePropertyName documentTitle -NotePropertyValue $documentTitle
        $windowSample = $sampleObject | ConvertTo-Json -Compress
    }
    if ($windowSample -ne $windowPrevious -or ($now - $lastOutput).TotalSeconds -ge 2) {
        [Console]::WriteLine($windowSample)
        [Console]::Out.Flush()
        $windowPrevious = $windowSample
        $lastOutput = $now
    }
    if (!$Once) { Start-Sleep -Milliseconds 250 }
} while (!$Once)
