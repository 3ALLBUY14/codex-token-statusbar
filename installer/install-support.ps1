$ErrorActionPreference = 'Stop'

function Get-StatusbarInstallRoot([string]$RequestedRoot) {
    $programs = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs'
    if (!$RequestedRoot) { $RequestedRoot = Join-Path $programs 'CodexTokenStatusbar' }
    $resolved = [IO.Path]::GetFullPath($RequestedRoot).TrimEnd('\')
    $normal = [IO.Path]::GetFullPath((Join-Path $programs 'CodexTokenStatusbar'))
    $test = [IO.Path]::GetFullPath((Join-Path $programs 'CodexTokenStatusbar-PackageTest'))
    if (![StringComparer]::OrdinalIgnoreCase.Equals($resolved, $normal) -and ![StringComparer]::OrdinalIgnoreCase.Equals($resolved, $test)) {
        throw 'Invalid installation directory.'
    }
    if ((Test-Path -LiteralPath $resolved) -and ((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Installation directory cannot be a symbolic link or junction.'
    }
    return $resolved
}

function Get-StatusbarIdentity([string]$InstallRoot) {
    $test = [IO.Path]::GetFileName($InstallRoot) -eq 'CodexTokenStatusbar-PackageTest'
    $suffix = if ($test) { '-PackageTest' } else { '' }
    return @{
        Name = 'Codex Token 状态条' + $(if ($test) { ' PackageTest' } else { '' })
        Registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexTokenStatusbar' + $suffix
        Startup = Join-Path ([Environment]::GetFolderPath('Startup')) ('CodexTokenStatusbar' + $suffix + '.lnk')
        Desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) ('Codex Token 状态条' + $suffix + '.lnk')
        Menu = Join-Path ([Environment]::GetFolderPath('Programs')) ('Codex Token 状态条' + $suffix)
    }
}

function Assert-StatusbarTransactionPath([string]$InstallRoot, [string]$Candidate, [string]$Kind) {
    $root = Get-StatusbarInstallRoot $InstallRoot
    if ($Kind -notin @('stage', 'backup')) { throw 'Invalid transaction directory kind.' }
    $resolved = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
    $prefix = $root + '.' + $Kind + '-'
    if (!$resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or $resolved.Substring($prefix.Length) -notmatch '^[0-9a-f]{32}$') {
        throw 'Transaction directory is outside the validated installation path.'
    }
    if ((Test-Path -LiteralPath $resolved) -and ((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Transaction directory cannot be a symbolic link or junction.'
    }
    return $resolved
}

function Stop-Statusbar([string]$InstallRoot) {
    $exe = Join-Path $InstallRoot 'CodexTokenStatusbar.exe'
    $processes = Get-Process -Name CodexTokenStatusbar -ErrorAction SilentlyContinue | Where-Object {
        [StringComparer]::OrdinalIgnoreCase.Equals($_.Path, $exe)
    }
    foreach ($process in $processes) {
        $children = Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + $process.Id) -ErrorAction SilentlyContinue
        $children | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*window-watch.ps1*' } | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 300
}

function New-StatusbarShortcut([string]$Filename, [string]$Target, [string]$Arguments, [string]$WorkingDirectory) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $Filename) -Force | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($Filename)
    $shortcut.TargetPath = $Target
    $shortcut.Arguments = $Arguments
    $shortcut.WorkingDirectory = $WorkingDirectory
    $shortcut.Description = 'Codex Token 状态条'
    $shortcut.Save()
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
}
