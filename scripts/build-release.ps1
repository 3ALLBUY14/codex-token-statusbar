param([switch]$SkipPackage)
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
function Get-StatusbarSha256([string]$filePath) {
    $stream = [IO.File]::OpenRead($filePath)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose(); $stream.Dispose() }
}
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$staging = $null
Push-Location $root
try {
    $version = (Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version
    if (!$SkipPackage) { & npm.cmd run package -- --electron-zip-dir=artifacts; if ($LASTEXITCODE -ne 0) { throw 'Packaging failed.' } }
    $package = Join-Path $root 'dist\CodexTokenStatusbar-win32-x64'
    if (!(Test-Path -LiteralPath (Join-Path $package 'CodexTokenStatusbar.exe'))) { throw 'Packaged app is missing.' }
    $releaseRoot = Join-Path $root 'release'
    $releaseName = 'CodexTokenStatusbar-' + $version + '-Windows-x64'
    $release = Join-Path $releaseRoot $releaseName
    $zip = $release + '.zip'
    $sha = $zip + '.sha256'
    if ((Test-Path -LiteralPath $release) -or (Test-Path -LiteralPath $zip) -or (Test-Path -LiteralPath $sha)) { throw 'Release already exists; use a new version or inspect the existing release first.' }
    New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
    $staging = [IO.Path]::GetFullPath((Join-Path $releaseRoot ('.staging-' + [Guid]::NewGuid().ToString('N'))))
    if (!$staging.StartsWith([IO.Path]::GetFullPath($releaseRoot) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid staging directory.' }
    $workRelease = Join-Path $staging $releaseName
    New-Item -ItemType Directory -Path $workRelease -Force | Out-Null
    $appDirectory = Join-Path $workRelease 'app'
    Copy-Item -LiteralPath $package -Destination $appDirectory -Recurse
    Copy-Item -LiteralPath README.md -Destination (Join-Path $appDirectory '使用说明.md')
    Copy-Item -LiteralPath LICENSE -Destination (Join-Path $appDirectory 'STATUSBAR-LICENSE.txt')
    Copy-Item -LiteralPath THIRD_PARTY_NOTICES.md -Destination $appDirectory
    $utf8Bom = New-Object Text.UTF8Encoding($true)
    foreach ($filename in @('install.ps1','install-support.ps1','uninstall.ps1')) {
        [IO.File]::WriteAllText((Join-Path $workRelease $filename), [IO.File]::ReadAllText((Join-Path $root ('installer\' + $filename))), $utf8Bom)
    }
    Copy-Item -LiteralPath installer\install.cmd -Destination (Join-Path $workRelease '安装.cmd')
    Copy-Item -LiteralPath installer\uninstall.cmd -Destination $workRelease
    $instructions = @"
Codex Token 状态条 $version — Windows x64

安装：
1. 先解压整个压缩包。
2. 双击「安装.cmd」，选择开机启动、桌面快捷方式，然后点击「安装并启动」。
3. 打开 Codex 桌面版，进入聊天，浮条默认显示在窗口右上方。

使用：鼠标进入浮条时自动半透明；点击 C 展开/收起明细；点击齿轮进入设置。
窄窗口显示 +N 时，点击 C 查看被收纳的指标和每轮工具明细。
浮条找不到时，双击桌面入口，或在托盘菜单/设置中选择「恢复浮条位置」。
切换聊天会自动跟随；多个 Codex 窗口可在设置中锁定聊天。
平均输出速度是包含推理和工具时间的轮次平均值。

更新：退出旧便携版状态条后，重新运行新包里的「安装.cmd」。显示偏好会保留。
安装版可以直接重新安装更新；安装器会验证新文件并在失败时恢复旧版，保留原来的快捷方式选择。
卸载：Windows「设置 → 应用」里卸载。
开机启动可在 Windows「设置 → 应用 → 启动」关闭，或重新安装时取消勾选。

无需管理员权限、Node.js 或 Python，安装和运行均无需下载额外组件。
支持 Windows 10/11 x64；已实测 Codex Desktop 26.930.2377.0。
这是第三方独立浮条，读取你朋友自己电脑的本地 Codex 日志。
包内没有制作者的账号、密钥、聊天日志或个人显示设置。
未使用代码签名；部分电脑可能提示未知发布者。
详细统计口径、权限和 MIT 授权见 app 目录中的使用说明和授权文件。
"@
    [IO.File]::WriteAllText((Join-Path $workRelease '使用说明.txt'), $instructions, $utf8Bom)
    $files = @(Get-ChildItem -LiteralPath $appDirectory -File -Recurse | ForEach-Object {
        @{ path = $_.FullName.Substring($appDirectory.Length + 1); sha256 = (Get-StatusbarSha256 $_.FullName) }
    })
    @{ version = $version; architecture = 'x64'; testedCodex = '26.930.2377.0'; files = $files } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $workRelease 'release.json') -Encoding UTF8
    $workZip = Join-Path $staging ($releaseName + '.zip')
    Compress-Archive -LiteralPath $workRelease -DestinationPath $workZip -CompressionLevel Optimal
    (Get-StatusbarSha256 $workZip) + '  ' + [IO.Path]::GetFileName($zip) | Set-Content -LiteralPath ($workZip + '.sha256') -Encoding ASCII
    Move-Item -LiteralPath $workRelease -Destination $release
    Move-Item -LiteralPath ($workZip + '.sha256') -Destination $sha
    Move-Item -LiteralPath $workZip -Destination $zip
    Get-Item -LiteralPath $zip | Select-Object FullName,Length
} finally {
    if ($staging -and (Test-Path -LiteralPath $staging)) {
        $resolvedStage = [IO.Path]::GetFullPath($staging)
        $resolvedRoot = [IO.Path]::GetFullPath((Join-Path $root 'release'))
        if ($resolvedStage.StartsWith($resolvedRoot + '\.staging-', [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $resolvedStage -Recurse -Force }
    }
    Pop-Location
}
