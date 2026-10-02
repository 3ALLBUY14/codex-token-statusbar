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
