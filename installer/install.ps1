param([switch]$Silent, [switch]$Startup, [switch]$DesktopShortcut, [switch]$NoLaunch, [string]$InstallRoot, [switch]$TestFailAfterSwap)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'install-support.ps1')

$stage = $null
$backup = $null
$backupMade = $false
$newInstalled = $false
$stopped = $false
$committed = $false
$wasRunning = $false
try {
    if (![Environment]::Is64BitOperatingSystem) { throw '需要 64 位 Windows 10 或 Windows 11。' }
    $InstallRoot = Get-StatusbarInstallRoot $InstallRoot
    $identity = Get-StatusbarIdentity $InstallRoot
    $hadOld = Test-Path -LiteralPath $InstallRoot
    $previousStartup = Test-Path -LiteralPath $identity.Startup
    $previousDesktop = Test-Path -LiteralPath $identity.Desktop
    $menuShortcut = Join-Path $identity.Menu 'Codex Token 状态条.lnk'
    $previousMenu = Test-Path -LiteralPath $menuShortcut
    $previousRegistry = if (Test-Path -LiteralPath $identity.Registry) { Get-ItemProperty -LiteralPath $identity.Registry } else { $null }
    if (!$PSBoundParameters.ContainsKey('Startup')) { $Startup = $previousStartup }
    if (!$PSBoundParameters.ContainsKey('DesktopShortcut')) { $DesktopShortcut = $previousDesktop }
    if ($TestFailAfterSwap -and (!$Silent -or [IO.Path]::GetFileName($InstallRoot) -ne 'CodexTokenStatusbar-PackageTest')) {
        throw 'Test failure mode is only available for the isolated package test installation.'
    }
    $source = Join-Path $PSScriptRoot 'app'
    $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release.json') -Raw | ConvertFrom-Json
    if (!(Test-Path -LiteralPath (Join-Path $source 'CodexTokenStatusbar.exe'))) { throw '安装文件不完整，请先解压整个安装包。' }
    foreach ($file in $manifest.files) {
        $payloadPath = [IO.Path]::GetFullPath((Join-Path $source $file.path))
        if (!$payloadPath.StartsWith([IO.Path]::GetFullPath($source) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '安装文件路径无效。' }
        if ((Get-FileHash -LiteralPath $payloadPath -Algorithm SHA256).Hash -ne $file.sha256) { throw ('安装文件校验失败：' + $file.path) }
    }
    if (!$Silent) {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        [Windows.Forms.Application]::EnableVisualStyles()
        $form = New-Object Windows.Forms.Form
        $form.Text = '安装 Codex Token 状态条 ' + $manifest.version
        $form.ClientSize = New-Object Drawing.Size(460, 250)
        $form.StartPosition = 'CenterScreen'
        $form.FormBorderStyle = 'FixedDialog'
        $form.MaximizeBox = $false
        $label = New-Object Windows.Forms.Label
        $label.Location = New-Object Drawing.Point(24, 24)
        $label.Size = New-Object Drawing.Size(410, 75)
        $label.Text = "为 Codex 桌面版显示 Token、上下文和平均输出速度。`r`n安装后打开 Codex 即可使用。`r`n重新安装会保留你的显示设置。"
        $startupBox = New-Object Windows.Forms.CheckBox
        $startupBox.Location = New-Object Drawing.Point(24, 112)
        $startupBox.AutoSize = $true
        $startupBox.Text = '登录 Windows 时自动启动'
        $startupBox.Checked = if ($hadOld) { $previousStartup } else { $true }
        $desktopBox = New-Object Windows.Forms.CheckBox
        $desktopBox.Location = New-Object Drawing.Point(24, 148)
        $desktopBox.AutoSize = $true
        $desktopBox.Text = '创建桌面快捷方式'
        $desktopBox.Checked = if ($hadOld) { $previousDesktop } else { $true }
        $installButton = New-Object Windows.Forms.Button
        $installButton.Location = New-Object Drawing.Point(270, 200)
        $installButton.Size = New-Object Drawing.Size(165, 32)
        $installButton.Text = '安装并启动'
        $installButton.DialogResult = 'OK'
        $form.AcceptButton = $installButton
        $form.Controls.AddRange(@($label, $startupBox, $desktopBox, $installButton))
        if ($form.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { $form.Dispose(); exit 0 }
        $Startup = $startupBox.Checked
        $DesktopShortcut = $desktopBox.Checked
        $form.Dispose()
    }

    $nonce = [Guid]::NewGuid().ToString('N')
    $stage = Assert-StatusbarTransactionPath $InstallRoot ($InstallRoot + '.stage-' + $nonce) 'stage'
    $backup = Assert-StatusbarTransactionPath $InstallRoot ($InstallRoot + '.backup-' + $nonce) 'backup'
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Get-ChildItem -LiteralPath $source | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $stage -Recurse -Force }
    foreach ($name in @('uninstall.ps1', 'install-support.ps1', 'uninstall.cmd')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $stage -Force
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'release.json') -Destination $stage -Force
    foreach ($file in $manifest.files) {
        $stagedPath = [IO.Path]::GetFullPath((Join-Path $stage $file.path))
        if (!$stagedPath.StartsWith($stage + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '安装文件路径无效。' }
        if ((Get-FileHash -LiteralPath $stagedPath -Algorithm SHA256).Hash -ne $file.sha256) { throw ('暂存文件校验失败：' + $file.path) }
    }

    $oldExe = Join-Path $InstallRoot 'CodexTokenStatusbar.exe'
    $wasRunning = @(Get-Process -Name CodexTokenStatusbar -ErrorAction SilentlyContinue | Where-Object {
        [StringComparer]::OrdinalIgnoreCase.Equals($_.Path, $oldExe)
    }).Count -gt 0
    Stop-Statusbar $InstallRoot
    $stopped = $true
    if ($hadOld) { Move-Item -LiteralPath $InstallRoot -Destination $backup; $backupMade = $true }
    Move-Item -LiteralPath $stage -Destination $InstallRoot
    $newInstalled = $true

    $exe = Join-Path $InstallRoot 'CodexTokenStatusbar.exe'
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $uninstallArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $InstallRoot 'uninstall.ps1') + '"'
    New-StatusbarShortcut $menuShortcut $exe '' $InstallRoot
    $oldUninstallShortcut = Join-Path $identity.Menu '卸载.lnk'
    if (Test-Path -LiteralPath $oldUninstallShortcut) { Remove-Item -LiteralPath $oldUninstallShortcut -Force }
    if ($DesktopShortcut) { New-StatusbarShortcut $identity.Desktop $exe '' $InstallRoot }
    elseif (Test-Path -LiteralPath $identity.Desktop) { Remove-Item -LiteralPath $identity.Desktop -Force }
    if ($Startup) { New-StatusbarShortcut $identity.Startup $exe '--autostart' $InstallRoot }
    elseif (Test-Path -LiteralPath $identity.Startup) { Remove-Item -LiteralPath $identity.Startup -Force }
    New-Item -Path $identity.Registry -Force | Out-Null
    $values = @{
        DisplayName = $identity.Name; DisplayVersion = $manifest.version; Publisher = 'Codex Token Statusbar Community'
        InstallLocation = $InstallRoot; DisplayIcon = $exe
        UninstallString = '"' + $powershell + '" ' + $uninstallArguments
        QuietUninstallString = '"' + $powershell + '" ' + $uninstallArguments + ' -Silent'
    }
    foreach ($key in $values.Keys) { New-ItemProperty -Path $identity.Registry -Name $key -Value $values[$key] -PropertyType String -Force | Out-Null }
    foreach ($key in @('NoModify','NoRepair')) { New-ItemProperty -Path $identity.Registry -Name $key -Value 1 -PropertyType DWord -Force | Out-Null }
    if ($TestFailAfterSwap) { throw 'Simulated failure after installation swap.' }
    if (!$NoLaunch) { Start-Process -FilePath $exe -WorkingDirectory $InstallRoot -WindowStyle Hidden | Out-Null }
    $committed = $true
    if ($backupMade) {
        try { Remove-Item -LiteralPath $backup -Recurse -Force; $backupMade = $false }
        catch { Write-Warning '旧版备份未能清理；新版本已安装。' }
    }
    if (!$Silent) { try { [void][Windows.Forms.MessageBox]::Show('安装完成。打开 Codex 即可显示浮条；也可以从桌面或开始菜单启动。', 'Codex Token 状态条') } catch {} }
    Write-Output ('Installed Codex Token Statusbar ' + $manifest.version)
    exit 0
} catch {
    $failure = $_
    if (!$committed -and ($newInstalled -or $backupMade -or $stopped)) {
        try {
            if ($newInstalled -and (Test-Path -LiteralPath $InstallRoot)) { Remove-Item -LiteralPath $InstallRoot -Recurse -Force }
            if ($backupMade -and (Test-Path -LiteralPath $backup)) { Move-Item -LiteralPath $backup -Destination $InstallRoot; $backupMade = $false }
            if ($previousStartup -and $hadOld) { New-StatusbarShortcut $identity.Startup (Join-Path $InstallRoot 'CodexTokenStatusbar.exe') '--autostart' $InstallRoot }
            elseif (Test-Path -LiteralPath $identity.Startup) { Remove-Item -LiteralPath $identity.Startup -Force }
            if ($previousDesktop -and $hadOld) { New-StatusbarShortcut $identity.Desktop (Join-Path $InstallRoot 'CodexTokenStatusbar.exe') '' $InstallRoot }
            elseif (Test-Path -LiteralPath $identity.Desktop) { Remove-Item -LiteralPath $identity.Desktop -Force }
            if ($previousMenu -and $hadOld) { New-StatusbarShortcut $menuShortcut (Join-Path $InstallRoot 'CodexTokenStatusbar.exe') '' $InstallRoot }
            elseif (Test-Path -LiteralPath $menuShortcut) { Remove-Item -LiteralPath $menuShortcut -Force }
            if ($previousRegistry) {
                New-Item -Path $identity.Registry -Force | Out-Null
                foreach ($key in @('DisplayName','DisplayVersion','Publisher','InstallLocation','DisplayIcon','UninstallString','QuietUninstallString','NoModify','NoRepair')) {
                    if ($previousRegistry.PSObject.Properties[$key]) {
                        $type = if ($key -in @('NoModify','NoRepair')) { 'DWord' } else { 'String' }
                        New-ItemProperty -Path $identity.Registry -Name $key -Value $previousRegistry.$key -PropertyType $type -Force | Out-Null
                    }
                }
            } elseif (Test-Path -LiteralPath $identity.Registry) { Remove-Item -LiteralPath $identity.Registry -Recurse -Force }
            if ($wasRunning -and $hadOld) { Start-Process -FilePath (Join-Path $InstallRoot 'CodexTokenStatusbar.exe') -WorkingDirectory $InstallRoot -WindowStyle Hidden | Out-Null }
        } catch { $failure = [Exception]::new('安装失败，旧版恢复也未完成：' + $failure.Exception.Message + ' / ' + $_.Exception.Message) }
    }
    if (!$Silent) { Add-Type -AssemblyName System.Windows.Forms; [void][Windows.Forms.MessageBox]::Show($failure.Exception.Message, '安装失败') }
    [Console]::Error.WriteLine($failure.Exception.Message)
    exit 1
} finally {
    if ($stage -and (Test-Path -LiteralPath $stage)) {
        try { $safeStage = Assert-StatusbarTransactionPath $InstallRoot $stage 'stage'; Remove-Item -LiteralPath $safeStage -Recurse -Force }
        catch { [Console]::Error.WriteLine('暂存目录未能清理：' + $_.Exception.Message) }
    }
}
