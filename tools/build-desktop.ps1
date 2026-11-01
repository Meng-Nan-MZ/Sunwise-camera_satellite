param([string]$DotnetPath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'runtime.ps1')
if (-not $DotnetPath) {
    $portable = Join-Path $projectRoot 'var\tools\dotnet\dotnet.exe'
    $DotnetPath = if (Test-Path -LiteralPath $portable) { $portable } else { 'dotnet' }
}
$env:DOTNET_CLI_HOME = Join-Path $projectRoot 'var\tools\dotnet-home'
$env:NUGET_PACKAGES = Join-Path $projectRoot 'var\tools\nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:NuGetAudit = 'false'
& $DotnetPath build (Join-Path $projectRoot 'apps\desktop\SatelliteStudio.Desktop.csproj') --configuration Release --runtime win-x64 --no-self-contained --output (Get-StudioDesktopBuildDirectory -ProjectRoot $projectRoot) -p:RestoreLockedMode=true
exit $LASTEXITCODE
