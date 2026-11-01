param(
    [Parameter(Mandatory = $true)][string]$Python,
    [string]$StagingName = 'release-2.2.1'
)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if ($StagingName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]*$') { throw 'Invalid staging directory name' }
$packaging = Join-Path $project 'var\packaging'
$lock = Get-Content -Raw -LiteralPath (Join-Path $project 'packaging\dependencies.lock.json') | ConvertFrom-Json
& $Python -B (Join-Path $PSScriptRoot 'fetch_dependencies.py') --offline
if ($LASTEXITCODE -ne 0) { throw 'Dependency verification failed' }
$arguments = @(
    '-B', (Join-Path $PSScriptRoot 'build_payload.py'),
    '--project-root', $project,
    '--desktop', (Join-Path $packaging 'publish\desktop'),
    '--python-runtime', (Join-Path $packaging 'runtimes\python'),
    '--blender-runtime', (Join-Path $packaging ('runtimes\blender\blender-' + $lock.runtime_versions.blender + '-windows-x64')),
    '--webview-runtime', (Join-Path $packaging ('webview-extracted\Microsoft.WebView2.FixedVersionRuntime.' + $lock.runtime_versions.webview2 + '.x64')),
    '--output', (Join-Path $packaging ('staging\' + $StagingName))
)
& $Python @arguments
if ($LASTEXITCODE -ne 0) { throw 'Payload assembly failed' }
