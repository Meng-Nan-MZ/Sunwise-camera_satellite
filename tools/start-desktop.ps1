param([string]$PythonPath, [string]$BlenderPath, [string]$Workspace)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'runtime.ps1')
$runtime = Get-StudioRuntime -ProjectRoot $projectRoot -PythonPath $PythonPath -BlenderPath $BlenderPath
if (-not $Workspace) { $Workspace = Join-Path $projectRoot 'var\workspace' }
$executable = Join-Path $projectRoot 'var\build\desktop\SatelliteStudio.Desktop.exe'
if (-not (Test-Path -LiteralPath $executable)) { throw 'Build the desktop first: tools/build-desktop.ps1' }
& $executable --project-root $projectRoot --workspace $Workspace --python $runtime.Python --blender $runtime.Blender
