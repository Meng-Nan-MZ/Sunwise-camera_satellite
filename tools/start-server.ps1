param([string]$PythonPath, [int]$Port = 8765, [string]$Workspace)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'runtime.ps1')
$runtime = Get-StudioRuntime -ProjectRoot $projectRoot -PythonPath $PythonPath
if (-not $Workspace) { $Workspace = Join-Path $projectRoot 'var\workspace' }
$env:PYTHONPATH = Join-Path $projectRoot 'python\src'
$env:PYTHONUTF8 = '1'
& $runtime.Python -u -m satellite_studio --project-root $projectRoot --workspace $Workspace --port $Port
exit $LASTEXITCODE
