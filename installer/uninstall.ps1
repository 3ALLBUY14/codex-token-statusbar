param([switch]$Silent)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-support.ps1')
try {
    $root = Get-StatusbarInstallRoot $PSScriptRoot
    $identity = Get-StatusbarIdentity $root
    if (!$Silent) {
        Add-Type -AssemblyName System.Windows.Forms
        if ([Windows.Forms.MessageBox]::Show('卸载 Codex Token 状态条？你的显示设置会保留，Codex 和聊天数据不会被删除。', '卸载', 'YesNo', 'Question') -ne 'Yes') { exit 0 }
    }
    Stop-Statusbar $root
    foreach ($shortcut in @($identity.Startup, $identity.Desktop)) {
        if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force }
    }
    if (Test-Path -LiteralPath $identity.Menu) { Remove-Item -LiteralPath $identity.Menu -Recurse -Force }
    $exe = Join-Path $root 'CodexTokenStatusbar.exe'
    # Electron creates these per-user entries for notification activation.
    $toastShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'CodexTokenStatusbar.lnk'
    if (Test-Path -LiteralPath $toastShortcut) {
        $shell = New-Object -ComObject WScript.Shell
        $link = $shell.CreateShortcut($toastShortcut)
        $ownsShortcut = [StringComparer]::OrdinalIgnoreCase.Equals($link.TargetPath, $exe)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
        if ($ownsShortcut) { Remove-Item -LiteralPath $toastShortcut -Force }
    }
    $toastClsid = 'HKCU:\Software\Classes\CLSID\{AEFF8848-6C82-4123-8D2A-E15979826C83}'
    $toastServer = Get-Item -LiteralPath (Join-Path $toastClsid 'LocalServer32') -ErrorAction SilentlyContinue
    if ($toastServer -and [StringComparer]::OrdinalIgnoreCase.Equals($toastServer.GetValue(''), $exe)) {
        Remove-Item -LiteralPath $toastClsid -Recurse -Force
    }
    if (Test-Path -LiteralPath $identity.Registry) { Remove-Item -LiteralPath $identity.Registry -Recurse -Force }
    # Get-StatusbarInstallRoot restricts this absolute path to the two app directories.
    Remove-Item -LiteralPath $root -Recurse -Force
    if (!$Silent) { [void][Windows.Forms.MessageBox]::Show('已卸载。', 'Codex Token 状态条') }
    exit 0
} catch {
    if (!$Silent) { Add-Type -AssemblyName System.Windows.Forms; [void][Windows.Forms.MessageBox]::Show($_.Exception.Message, '卸载失败') }
    Write-Error $_
    exit 1
}
