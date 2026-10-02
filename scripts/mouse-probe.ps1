param([int]$StartX, [int]$StartY, [int]$EndX, [int]$EndY, [bool]$Drag = $false)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StatusbarMouseProbe {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@
[void][StatusbarMouseProbe]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
[void][StatusbarMouseProbe]::SetCursorPos($StartX, $StartY)
Start-Sleep -Milliseconds 350
try {
    if ($Drag) { [StatusbarMouseProbe]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 350 }
    for ($mouseStep = 1; $mouseStep -le 12; $mouseStep++) {
        $mouseX = [int][Math]::Round($StartX + ($EndX - $StartX) * $mouseStep / 12)
        $mouseY = [int][Math]::Round($StartY + ($EndY - $StartY) * $mouseStep / 12)
        [void][StatusbarMouseProbe]::SetCursorPos($mouseX, $mouseY)
        Start-Sleep -Milliseconds 30
    }
} finally {
    if ($Drag) { [StatusbarMouseProbe]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) }
}
Start-Sleep -Milliseconds 200
