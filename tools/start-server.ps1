param([string]$PythonPath, [string]$BlenderPath, [int]$Port = 8765, [string]$Workspace)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'runtime.ps1')
$runtime = Get-StudioRuntime -ProjectRoot $projectRoot -PythonPath $PythonPath -BlenderPath $BlenderPath
if (-not $Workspace) { $Workspace = Join-Path $projectRoot 'var\workspace' }
$env:PYTHONPATH = Join-Path $projectRoot 'python\src'
$env:PYTHONUTF8 = '1'
& $runtime.Python -u -m satellite_studio --project-root $projectRoot --workspace $Workspace --blender $runtime.Blender --port $Port
exit $LASTEXITCODE
