[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadDirectory,
    [ValidatePattern('^\d+\.\d+\.\d+$')]
    [string]$Version = '2.2.0',
    [string]$OutputDirectory,
    [string]$CompilerPath,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))

function Full-ProjectPath([string]$Value) {
    if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
    return [IO.Path]::GetFullPath((Join-Path $projectRoot $Value))
}

if (-not $OutputDirectory) { $OutputDirectory = 'var/releases' }
if (-not $CompilerPath) { $CompilerPath = 'var/packaging/tools/inno/ISCC.exe' }
$payload = Full-ProjectPath $PayloadDirectory
$output = Full-ProjectPath $OutputDirectory
$compiler = Full-ProjectPath $CompilerPath
$definition = Join-Path $projectRoot 'packaging/installer/SatelliteDatasetStudio.iss'
$manifestPath = Join-Path $payload 'release-manifest.json'
foreach ($file in @($compiler, $definition, $manifestPath)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required packaging file is missing: $file" }
}
$languageFile = Join-Path (Split-Path -Parent $compiler) 'Languages/ChineseSimplified.isl'
if (-not (Test-Path -LiteralPath $languageFile -PathType Leaf)) {
    throw "The Inno compiler lacks ChineseSimplified.isl: $languageFile"
}
$compilerVersion = (& $compiler --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $compilerVersion -notmatch '^\d+\.\d+\.\d+$' -or
    ([version]$compilerVersion).Major -lt 7) {
    throw "A working Inno Setup 7 or newer compiler is required: $compilerVersion"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.product -ne 'Satellite Dataset Studio V2' -or
    $manifest.version -ne $Version -or $manifest.platform -ne 'windows-x64') {
    throw 'Payload product, version or platform does not match this installer.'
}
$entries = @($manifest.files)
if ($entries.Count -eq 0 -or $entries.Count -ne [long]$manifest.file_count) {
    throw 'The release manifest file count is empty or inconsistent.'
}
$payloadPrefix = $payload.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if ($output.Equals($payload, [StringComparison]::OrdinalIgnoreCase) -or
    $output.StartsWith($payloadPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installer output must be outside the immutable payload directory.'
}
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
[long]$totalBytes = 0
Write-Host "Verifying $($entries.Count) payload files before compilation..."
foreach ($entry in $entries) {
    $relative = [string]$entry.path
    if ([string]::IsNullOrWhiteSpace($relative) -or $relative.Contains('\') -or
        [IO.Path]::IsPathRooted($relative) -or $relative -match '[<>:"|?*\x00-\x1f]' -or
        @($relative.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -gt 0) {
        throw "Unsafe manifest path: $relative"
    }
    if (-not $seen.Add($relative)) { throw "Duplicate manifest path: $relative" }
    $file = [IO.Path]::GetFullPath((Join-Path $payload $relative))
    if (-not $file.StartsWith($payloadPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Manifest path escapes the payload: $relative"
    }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing payload file: $relative" }
    $item = Get-Item -LiteralPath $file
    if ($item.Length -ne [long]$entry.size_bytes) { throw "Payload size mismatch: $relative" }
    if ([string]$entry.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "Invalid manifest SHA256: $relative" }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.sha256) {
        throw "Payload SHA256 mismatch: $relative"
    }
    $totalBytes += $item.Length
}
if ($totalBytes -ne [long]$manifest.size_bytes) { throw 'Manifest total byte count does not match.' }

# Links and unlisted files must not silently enter a release payload.
foreach ($item in @(Get-ChildItem -LiteralPath $payload -Force -Recurse)) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Payload contains a reparse point: $($item.FullName)"
    }
    if (-not $item.PSIsContainer -and $item.FullName -ne $manifestPath) {
        $relative = $item.FullName.Substring($payloadPrefix.Length).Replace('\', '/')
        if (-not $seen.Contains($relative)) { throw "Unlisted payload file: $relative" }
    }
}
foreach ($required in @('SatelliteStudio.Desktop.exe', 'docs/使用说明.html',
    'runtime/python/python.exe', 'runtime/blender/blender.exe',
    'runtime/webview2/msedgewebview2.exe', 'apps/ui/dist/index.html')) {
    if (-not $seen.Contains($required)) { throw "Required release entry is absent: $required" }
}

New-Item -ItemType Directory -Path $output -Force | Out-Null
$baseName = "SatelliteDatasetStudio-V2-$Version-win-x64-setup"
$installer = Join-Path $output ($baseName + '.exe')
if ((Test-Path -LiteralPath $installer) -and -not $Force) {
    throw "Installer already exists; use -Force for an intentional rebuild: $installer"
}
$compilerLog = Join-Path $output ($baseName + '.compiler.log')
$arguments = @('--no-ide-signtools', '--no-signing',
    "/DAppVersion=$Version", "/DPayloadDir=$payload", "/DOutputDir=$output",
    "/DOutputBaseName=$baseName", $definition)
& $compiler @arguments 2>&1 | Tee-Object -FilePath $compilerLog
$compilerExit = $LASTEXITCODE
if ($compilerExit -ne 0) { throw "Inno Setup failed with exit code $compilerExit. See $compilerLog" }
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw 'The compiler reported success but the expected installer was not created.'
}
$digest = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
$digest + '  ' + [IO.Path]::GetFileName($installer) |
    Set-Content -LiteralPath ($installer + '.sha256') -Encoding ASCII
$record = [ordered]@{
    version = $Version
    installer = [IO.Path]::GetFileName($installer)
    size_bytes = (Get-Item -LiteralPath $installer).Length
    sha256 = $digest
    payload_file_count = $entries.Count
    payload_size_bytes = $totalBytes
    payload_manifest_sha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    compiler = $compiler
    compiler_version = $compilerVersion
    signed = $false
    built_utc = (Get-Date).ToUniversalTime().ToString('o')
}
$record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output ($baseName + '.build.json')) -Encoding UTF8
$record | ConvertTo-Json
