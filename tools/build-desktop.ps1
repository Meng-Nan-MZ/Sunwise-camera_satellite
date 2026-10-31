param([string]$DotnetPath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (-not $DotnetPath) {
    $portable = Join-Path $projectRoot 'var\tools\dotnet\dotnet.exe'
    $DotnetPath = if (Test-Path -LiteralPath $portable) { $portable } else { 'dotnet' }
}
$env:DOTNET_CLI_HOME = Join-Path $projectRoot 'var\tools\dotnet-home'
$env:NUGET_PACKAGES = Join-Path $projectRoot 'var\tools\nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
& $DotnetPath build (Join-Path $projectRoot 'apps\desktop\SatelliteStudio.Desktop.csproj') --configuration Release --output (Join-Path $projectRoot 'var\build\desktop') -p:RestoreLockedMode=true
exit $LASTEXITCODE
