[CmdletBinding()]
param(
    [string]$InstallerPath,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$NodePath,
    [string]$NodeModulesPath,
    [ValidateRange(1024, 65535)][int]$DebugPort = 9234,
    [ValidateRange(1, 120)][int]$WaitForBuildMinutes = 30,
    [switch]$SkipReadOnlyCheck,
    [switch]$PreflightOnly
)

throw 'V2.4 installer functional QA is pending adaptation to the two-page web-only workbench. No installer acceptance is claimed. Use tools/verify_v24_workbench.cjs for development-build acceptance.'

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$verificationRoot = Join-Path $projectRoot 'var/packaging/verification'
$releaseRoot = Join-Path $projectRoot 'var/releases'
$registryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{B46CE219-98FD-430C-AC12-A09EC62CC127}_is1'
$registry32Path = 'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\{B46CE219-98FD-430C-AC12-A09EC62CC127}_is1'
$menuDirectory = Join-Path ([Environment]::GetFolderPath('Programs')) 'Satellite Dataset Studio V2'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Satellite Dataset Studio V2.lnk'
$verifier = Join-Path $PSScriptRoot 'verify_installed.cjs'

function Assert-Within([string]$Base, [string]$Candidate) {
    $basePath = [IO.Path]::GetFullPath($Base).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $full = [IO.Path]::GetFullPath($Candidate)
    if (-not $full.StartsWith($basePath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path must be strictly inside $basePath : $full"
    }
    # Reject junctions in existing ancestors, so lexical containment is reliable.
    $current = $full
    while ($current -and $current.StartsWith($basePath, [StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $current) {
            if (((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Verification paths must not contain reparse points: $current"
            }
        }
        if ($current.Equals($basePath, [StringComparison]::OrdinalIgnoreCase)) { break }
        $current = Split-Path -Parent $current
    }
    return $full
}

function Assert-NoExistingInstallation {
    if ((Test-Path -LiteralPath $registryPath) -or (Test-Path -LiteralPath $registry32Path)) {
        throw 'An existing Satellite Dataset Studio V2 installation is registered in HKCU. No installation or uninstall was attempted.'
    }
    if (Test-Path -LiteralPath $menuDirectory) {
        throw "An existing Start Menu group could be overwritten: $menuDirectory. No installation was attempted."
    }
}

function Get-RegisteredDirectory {
    if (-not (Test-Path -LiteralPath $registryPath)) { return $null }
    $properties = Get-ItemProperty -LiteralPath $registryPath
    foreach ($name in @('InstallLocation', 'Inno Setup: App Path')) {
        $property = $properties.PSObject.Properties[$name]
        if ($property -and $property.Value) {
            return [IO.Path]::GetFullPath([string]$property.Value).TrimEnd([IO.Path]::DirectorySeparatorChar)
        }
    }
    throw 'The uninstall registry entry has no identifiable installation directory.'
}

function Get-DataHashes([string]$Workspace) {
    $result = @{}
    $jobs = Join-Path $Workspace 'jobs'
    if (Test-Path -LiteralPath $jobs) {
        foreach ($file in @(Get-ChildItem -LiteralPath $jobs -File -Recurse -Force)) {
            $relative = $file.FullName.Substring($Workspace.Length + 1)
            $result[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    foreach ($name in @('userdata-preserved.txt', 'jobs.sqlite3', 'jobs.sqlite3-wal', 'jobs.sqlite3-shm')) {
        $file = Join-Path $Workspace $name
        if (Test-Path -LiteralPath $file -PathType Leaf) { $result[$name] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    return $result
}

function Assert-Preserved([hashtable]$Before, [hashtable]$After) {
    if ($Before.Count -ne $After.Count) { throw 'Workspace file count changed during uninstall.' }
    foreach ($name in $Before.Keys) {
        if (-not $After.ContainsKey($name) -or $After[$name] -ne $Before[$name]) {
            throw "Uninstall changed or removed workspace data: $name"
        }
    }
}

function Write-Report($Value, [string]$Destination) {
    $Value | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath $Destination -Encoding UTF8
}

if (-not $InstallerPath) { $InstallerPath = Join-Path $releaseRoot 'SatelliteDatasetStudio-V2-2.4.0-win-x64-setup.exe' }
$installer = Assert-Within $releaseRoot $InstallerPath
if ([IO.Path]::GetFileName($installer) -ne 'SatelliteDatasetStudio-V2-2.4.0-win-x64-setup.exe') { throw 'Unexpected installer name/version.' }
foreach ($file in @($NodePath, $verifier)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required verification tool is missing: $file" }
}
if (-not $NodeModulesPath) { $NodeModulesPath = Join-Path (Split-Path -Parent (Split-Path -Parent $NodePath)) 'node_modules' }
if (-not (Test-Path -LiteralPath (Join-Path $NodeModulesPath 'playwright/package.json') -PathType Leaf)) {
    throw "Playwright was not found in test dependency directory: $NodeModulesPath"
}
Assert-NoExistingInstallation
if ($PreflightOnly) {
    Write-Output 'PASS: no existing registration or Start Menu group; verification tools and path constraints are valid. No installer was run.'
    return
}

$buildPath = [IO.Path]::ChangeExtension($installer, '.build.json')
$hashPath = $installer + '.sha256'
$deadline = (Get-Date).AddMinutes($WaitForBuildMinutes)
$lastWait = [datetime]::MinValue
$build = $null
while ((Get-Date) -lt $deadline) {
    if ((Test-Path -LiteralPath $installer -PathType Leaf) -and
        (Test-Path -LiteralPath $buildPath -PathType Leaf) -and (Test-Path -LiteralPath $hashPath -PathType Leaf)) {
        try {
            $candidate = Get-Content -LiteralPath $buildPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $sidecar = (Get-Content -LiteralPath $hashPath -Raw).Trim()
            if ($candidate.version -ne '2.4.0' -or $candidate.installer -ne [IO.Path]::GetFileName($installer) -or
                [string]$candidate.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'Invalid completed-build metadata.' }
            if ($sidecar -notmatch '^([0-9a-fA-F]{64})\s+\*?(.+)$' -or $Matches[2] -ne [IO.Path]::GetFileName($installer)) {
                throw 'Invalid installer SHA256 sidecar.'
            }
            $sidecarHash = $Matches[1]
            $installerInfo = Get-Item -LiteralPath $installer
            $actualHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actualHash -ne $candidate.sha256 -or $actualHash -ne $sidecarHash -or $installerInfo.Length -ne [long]$candidate.size_bytes) {
                throw 'Installer has not reached its completed build hash/size.'
            }
            $build = $candidate
            break
        } catch { Write-Host "Build not yet verified: $($_.Exception.Message)" }
    }
    if (((Get-Date) - $lastWait).TotalSeconds -ge 30) { Write-Host 'Waiting for completed installer, build.json and SHA256 sidecar...'; $lastWait = Get-Date }
    Start-Sleep -Seconds 5
}
if (-not $build) { throw 'Timed out waiting for a complete hash-verified installer. No installer was run.' }
Assert-NoExistingInstallation
$runName = '安装验收 ' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$runRoot = Assert-Within $verificationRoot (Join-Path $verificationRoot $runName)
if (Test-Path -LiteralPath $runRoot) { throw "Verification directory already exists: $runRoot" }
New-Item -ItemType Directory -Path $runRoot | Out-Null
$appDirectory = Assert-Within $runRoot (Join-Path $runRoot '安装 程序')
$workspace = Assert-Within $runRoot (Join-Path $runRoot '用户 数据')
$evidence = Assert-Within $runRoot (Join-Path $runRoot '应用 截图与报告')
$reportPath = Join-Path $runRoot 'installer-lifecycle.json'
$installLog = Join-Path $runRoot 'install.log'
$uninstallLog = Join-Path $runRoot 'uninstall.log'
$menuApp = Join-Path $menuDirectory 'Satellite Dataset Studio V2.lnk'
$menuHelp = Join-Path $menuDirectory '使用说明.lnk'
$originalDesktopHash = if (Test-Path -LiteralPath $desktopShortcut) { (Get-FileHash -LiteralPath $desktopShortcut -Algorithm SHA256).Hash } else { $null }
$report = [ordered]@{
    started_utc = (Get-Date).ToUniversalTime().ToString('o'); passed = $false; installer = $installer; build = $build
    test_root = $runRoot; application_directory = $appDirectory; workspace = $workspace; application_evidence = $evidence
    scope = 'Local development-machine acceptance, not a clean Windows VM. Application-only proxy blocks external browser access; no system network setting is changed.'
    installation = @{}; read_only = @{ requested = -not $SkipReadOnlyCheck; applied = $false; restored = $false }
    application = @{ passed = $false }; uninstall = @{ application_removed = $false }; preservation = @{}; errors = [Collections.Generic.List[string]]::new()
}
$originalAcl = $null
$denyApplied = $false
$installAttempted = $false
$dataBefore = @{}
$priorNodePath = $env:NODE_PATH
Write-Host "Verification output: $runRoot"
Write-Report $report $reportPath
try {
    # Re-check immediately before touching HKCU or shortcuts.
    Assert-NoExistingInstallation
    if (Test-Path -LiteralPath $appDirectory) { throw 'The application test directory must be newly created by the installer.' }
    if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $build.sha256) { throw 'Installer changed after hash verification.' }
    $installArguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/TASKS=""',
        ('/DIR="{0}"' -f $appDirectory), ('/LOG="{0}"' -f $installLog))
    Write-Host 'Installing the verified package into the dedicated Chinese/spaced test directory...'
    $installAttempted = $true
    $installation = Start-Process -FilePath $installer -ArgumentList $installArguments -WindowStyle Hidden -Wait -PassThru
    $report.installation.exit_code = $installation.ExitCode
    if ($installation.ExitCode -ne 0) { throw "Installer exited with code $($installation.ExitCode)." }
    $registered = Get-RegisteredDirectory
    if ($registered -ne $appDirectory) { throw "Registered installation does not match the test directory: $registered" }
    $report.installation.registered_directory = $registered
    $appExecutable = Join-Path $appDirectory 'SatelliteStudio.Desktop.exe'
    $webviewExecutable = Join-Path $appDirectory 'runtime/webview2/msedgewebview2.exe'
    foreach ($file in @($appExecutable, $webviewExecutable, (Join-Path $appDirectory 'unins000.exe'), $menuApp, $menuHelp)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Installed file or shortcut is missing: $file" }
    }
    $shell = New-Object -ComObject WScript.Shell
    try {
        $appTarget = $shell.CreateShortcut($menuApp).TargetPath
        $helpTarget = $shell.CreateShortcut($menuHelp).TargetPath
        if ($appTarget -ne $appExecutable -or $helpTarget -ne (Join-Path $appDirectory 'docs/使用说明.html')) { throw 'Start Menu shortcut points outside this test installation.' }
        $report.installation.shortcuts = @(@{ path = $menuApp; target = $appTarget }, @{ path = $menuHelp; target = $helpTarget })
    } finally { [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null }
    if (Test-Path -LiteralPath $desktopShortcut) {
        if (-not $originalDesktopHash -or (Get-FileHash -LiteralPath $desktopShortcut -Algorithm SHA256).Hash -ne $originalDesktopHash) { throw 'An unrequested Desktop shortcut was created or changed.' }
    }
    $rules = (Get-Acl -LiteralPath $webviewExecutable).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    $requiredRights = [Security.AccessControl.FileSystemRights]::ReadAndExecute
    $report.installation.webview_acl = @()
    foreach ($sid in @('S-1-15-2-1', 'S-1-15-2-2')) {
        $sidRules = @($rules | Where-Object { $_.IdentityReference.Value -eq $sid -and $_.IsInherited -and
            $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
            ($_.FileSystemRights -band $requiredRights) -eq $requiredRights })
        if ($sidRules.Count -eq 0) { throw "WebView2 is missing inherited ReadAndExecute permission for $sid" }
        $report.installation.webview_acl += @{ sid = $sid; inherited_rx = $true }
    }
    if (-not $SkipReadOnlyCheck) {
        Assert-Within $runRoot $appDirectory | Out-Null
        $originalAcl = Get-Acl -LiteralPath $appDirectory
        $originalAcl.Sddl | Set-Content -LiteralPath (Join-Path $runRoot 'application-original-acl.sddl') -Encoding ASCII
        $readOnlyAcl = Get-Acl -LiteralPath $appDirectory
        $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $deny = [Security.AccessControl.FileSystemAccessRule]::new($userSid, [Security.AccessControl.FileSystemRights]::Write,
            [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
            [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Deny)
        $readOnlyAcl.AddAccessRule($deny) | Out-Null
        $denyApplied = $true
        Set-Acl -LiteralPath $appDirectory -AclObject $readOnlyAcl
        $probe = Join-Path $appDirectory '.verification-write-probe'
        $writeBlocked = $false
        try { [IO.File]::WriteAllText($probe, 'must be denied') }
        catch [UnauthorizedAccessException] { $writeBlocked = $true }
        if (-not $writeBlocked) { throw 'Read-only ACL did not prevent writing to the application directory.' }
        $inheritedDeny = @((Get-Acl -LiteralPath $webviewExecutable).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
            $_.IdentityReference.Value -eq $userSid.Value -and $_.IsInherited -and $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny -and
            ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -eq [Security.AccessControl.FileSystemRights]::Write })
        if (-not $inheritedDeny.Count) { throw 'Read-only permission did not inherit to the packaged runtime.' }
        $report.read_only.applied = $true
        $report.read_only.user_sid = $userSid.Value
        $report.read_only.write_probe_denied = $writeBlocked
    }
    Write-Report $report $reportPath
    Write-Host 'Running installed desktop, six-model, render, queue/cancel and native close acceptance...'
    $env:NODE_PATH = $NodeModulesPath
    $verifyArguments = @(('"{0}"' -f $verifier), '--app-dir', ('"{0}"' -f $appDirectory), '--workspace', ('"{0}"' -f $workspace),
        '--output', ('"{0}"' -f $evidence), '--debug-port', [string]$DebugPort)
    $verification = Start-Process -FilePath $NodePath -ArgumentList $verifyArguments -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $runRoot 'application.stdout.log') -RedirectStandardError (Join-Path $runRoot 'application.stderr.log')
    $report.application.exit_code = $verification.ExitCode
    $applicationReport = Join-Path $evidence 'report.json'
    if (Test-Path -LiteralPath $applicationReport) {
        $application = Get-Content -LiteralPath $applicationReport -Raw -Encoding UTF8 | ConvertFrom-Json
        $report.application.report = $applicationReport
        $report.application.passed = $application.passed
    } else { throw 'Application verifier did not produce report.json.' }
    if ($verification.ExitCode -ne 0 -or -not $application.passed) { throw 'Installed application verification failed; evidence is retained and test installation will be removed.' }
} catch {
    $report.errors.Add($_.Exception.Message)
    Write-Warning $_.Exception.Message
} finally {
    $env:NODE_PATH = $priorNodePath
    # Capture even partial job artifacts, then prove uninstall did not alter them.
    try {
        New-Item -ItemType Directory -Path $workspace -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $workspace 'userdata-preserved.txt'), "Preserve this verification dataset: $runName`n", [Text.UTF8Encoding]::new($false))
        $dataBefore = Get-DataHashes $workspace
        Write-Report $dataBefore (Join-Path $runRoot 'workspace-hashes-before-uninstall.json')
        $report.preservation.file_count_before = $dataBefore.Count
        $report.preservation.png_count_before = @($dataBefore.Keys | Where-Object { $_ -match '\.png$' }).Count
    } catch { $report.errors.Add('Data preservation snapshot: ' + $_.Exception.Message) }
    if ($denyApplied -and $originalAcl) {
        try {
            Assert-Within $runRoot $appDirectory | Out-Null
            Set-Acl -LiteralPath $appDirectory -AclObject $originalAcl
            if ((Get-Acl -LiteralPath $appDirectory).Sddl -ne $originalAcl.Sddl) { throw 'Restored application ACL differs from original.' }
            $report.read_only.restored = $true
            $probe = Join-Path $appDirectory '.verification-write-probe'
            if (Test-Path -LiteralPath $probe -PathType Leaf) { Remove-Item -LiteralPath $probe }
        } catch { $report.errors.Add('ACL restoration: ' + $_.Exception.Message) }
    }
    if ($installAttempted) {
        try {
            $registered = Get-RegisteredDirectory
            if ($registered -and $registered -ne $appDirectory) { throw "Refusing to uninstall: AppId now belongs to another directory: $registered" }
            $uninstaller = Assert-Within $runRoot (Join-Path $appDirectory 'unins000.exe')
            if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
                Write-Host 'Uninstalling only the dedicated test installation; retaining all workspace data...'
                $uninstallArguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/LOG="{0}"' -f $uninstallLog))
                $uninstallation = Start-Process -FilePath $uninstaller -ArgumentList $uninstallArguments -WindowStyle Hidden -Wait -PassThru
                $report.uninstall.exit_code = $uninstallation.ExitCode
                if ($uninstallation.ExitCode -ne 0) { throw "Uninstaller exited with code $($uninstallation.ExitCode)." }
            } elseif ($registered) { throw 'Registered test installation has no uninstaller; manual investigation required.' }
            if ((Test-Path -LiteralPath $registryPath) -or (Test-Path -LiteralPath $registry32Path)) { throw 'Uninstall registration remained after test uninstall.' }
            foreach ($shortcut in @($menuApp, $menuHelp)) { if (Test-Path -LiteralPath $shortcut) { throw "Test Start Menu shortcut remained: $shortcut" } }
            if (Test-Path -LiteralPath (Join-Path $appDirectory 'SatelliteStudio.Desktop.exe')) { throw 'Desktop EXE remained after uninstall.' }
            $report.uninstall.registration_removed = $true
            $report.uninstall.start_menu_shortcuts_removed = $true
            $report.uninstall.application_removed = $true
        } catch { $report.errors.Add('Uninstall: ' + $_.Exception.Message) }
    }
    try {
        $dataAfter = Get-DataHashes $workspace
        Assert-Preserved $dataBefore $dataAfter
        Write-Report $dataAfter (Join-Path $runRoot 'workspace-hashes-after-uninstall.json')
        $report.preservation.hashes_unchanged = $true
        $report.preservation.marker_retained = Test-Path -LiteralPath (Join-Path $workspace 'userdata-preserved.txt')
        if ($originalDesktopHash) {
            if (-not (Test-Path -LiteralPath $desktopShortcut) -or (Get-FileHash -LiteralPath $desktopShortcut -Algorithm SHA256).Hash -ne $originalDesktopHash) { throw 'Existing Desktop shortcut was changed.' }
        } elseif (Test-Path -LiteralPath $desktopShortcut) { throw 'Unrequested Desktop shortcut remained.' }
    } catch { $report.errors.Add('Preservation: ' + $_.Exception.Message) }
    $report.passed = $report.errors.Count -eq 0 -and $report.application.passed -and $report.uninstall.application_removed
    $report.finished_utc = (Get-Date).ToUniversalTime().ToString('o')
    Write-Report $report $reportPath
    Write-Output ($report | ConvertTo-Json -Depth 15)
}
if (-not $report.passed) { throw "Installer lifecycle acceptance failed. See $reportPath" }
