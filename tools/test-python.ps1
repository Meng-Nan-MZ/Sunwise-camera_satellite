param([string]$PythonPath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'runtime.ps1')
$runtime = Get-StudioRuntime -ProjectRoot $projectRoot -PythonPath $PythonPath
$env:PYTHONPATH = Join-Path $projectRoot 'python\src'
$env:PYTHONUTF8 = '1'
foreach ($suite in @('python', 'rendering')) {
    & $runtime.Python -m unittest discover -s (Join-Path $projectRoot "tests\$suite") -v
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
