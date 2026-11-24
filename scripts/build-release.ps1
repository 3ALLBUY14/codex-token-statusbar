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
    $metadata = Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json
    $version = $metadata.version
    $displayVersion = if ($metadata.displayVersion) { $metadata.displayVersion } else { $version }
    $testedCodex = '26.1120.5083.0'
    if ($displayVersion -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw 'Invalid display version.' }
    if (!$SkipPackage) { & npm.cmd run package -- --electron-zip-dir=artifacts; if ($LASTEXITCODE -ne 0) { throw 'Packaging failed.' } }
    $package = Join-Path $root 'dist\CodexTokenStatusbar-win32-x64'
    if (!(Test-Path -LiteralPath (Join-Path $package 'CodexTokenStatusbar.exe'))) { throw 'Packaged app is missing.' }
    $releaseRoot = Join-Path $root 'release'
    $releaseName = 'CodexTokenStatusbar-' + $displayVersion + '-Windows-x64'
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
Codex Token 状态条 $displayVersion — Windows x64

安装：
1. 先解压整个压缩包。
2. 双击「安装.cmd」，选择开机启动、桌面快捷方式，然后点击「安装并启动」。
3. 打开 Codex 桌面版，进入聊天，浮条默认显示在窗口右上方。

使用：鼠标进入浮条时自动半透明；点击 C 展开/收起明细；点击齿轮进入设置。
第三方桌面默认启用加强置顶；在其他应用上仍要显示时，勾选“切换到其他应用时仍显示”。
设置 → 贴靠与位置：启用“跟随窗口贴靠”，可选“标题栏内”或“输入框附近”。
标题栏自动避开菜单和窗口按钮、适应栏高，明细向下展开；输入框模式优先下方，空间不足放上方。
“贴靠对齐”可选自适应居中、靠左或靠右；明细开合时保持浮条对齐，区域和对齐选择自动保存。
贴靠是独立浮层，未修改 Codex；离开 Codex 或未识别到贴靠区域时隐藏，关闭后恢复原浮动位置。
窄窗口显示 +N 时，点击 C 查看被收纳的指标和每轮工具明细。
浮条找不到时，双击桌面入口，或在托盘菜单/设置中选择「恢复浮条位置」。
切换聊天会自动跟随；多个 Codex 窗口可在设置中锁定聊天。
平均输出速度是包含推理和工具时间的轮次平均值。
明细可切换“总览 / 用量 / 模型 / 请求”。总览显示分段上下文和账号额度。
额度在启动时及每 5 分钟查询 Codex，点击 ↻ 可手动刷新。ChatGPT Pro 只显示周额度。
“用量”页支持当前聊天或全部本地聊天，查看 7 天、30 天或近一年的每日 Token 趋势和热力图。
“模型”页查看各模型用量，“请求”页查看逐请求明细。设置里的“模型请求”额外支持日期筛选。
设置侧栏提供外观、指标排序、贴靠与位置、聊天范围、工具记录、模型请求和诊断。
在“诊断 → 版本更新”选择自动提示、Windows 通知或仅手动检查，点击更新通知会打开版本更新页。
同一聊天跨模型保留累计；部分历史无法逐请求归属时，差额列为“历史未归属”，不重复相加。
C → 总览 → 用量来源与模型，或设置 → 聊天范围，可切换是否纳入关联子任务。
新格式按已记录请求去重，历史不完整时会标注，读数可能小于旧版累计；速度仍为上一轮均速。

更新：退出旧便携版状态条后，重新运行新包里的「安装.cmd」。显示偏好会保留。
安装版可以直接重新安装更新；安装器会验证新文件并在失败时恢复旧版，保留原来的快捷方式选择。
卸载：Windows「设置 → 应用」里卸载。
开机启动可在 Windows「设置 → 应用 → 启动」关闭，或重新安装时取消勾选。

无需管理员权限、Node.js 或 Python。
支持 Windows 10/11 x64；已实测 Codex Desktop $testedCodex。
Token 等统计来自本机 Codex 日志。官方额度查询需要登录 Codex 并联网。
包内没有制作者的账号、密钥、聊天日志或个人显示设置。
未使用代码签名；部分电脑可能提示未知发布者。
详细统计口径、权限和 MIT 授权见 app 目录中的使用说明和授权文件。
"@
    [IO.File]::WriteAllText((Join-Path $workRelease '使用说明.txt'), $instructions, $utf8Bom)
    $files = @(Get-ChildItem -LiteralPath $appDirectory -File -Recurse | ForEach-Object {
        @{ path = $_.FullName.Substring($appDirectory.Length + 1); sha256 = (Get-StatusbarSha256 $_.FullName) }
    })
    @{ version = $version; displayVersion = $displayVersion; architecture = 'x64'; testedCodex = $testedCodex; files = $files } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $workRelease 'release.json') -Encoding UTF8
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
