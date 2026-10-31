function Get-StudioRuntime {
    param([string]$ProjectRoot, [string]$PythonPath, [string]$BlenderPath)
    $configPath = Join-Path $ProjectRoot 'var\runtime.json'
    $config = if (Test-Path -LiteralPath $configPath) { Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json } else { $null }
    if (-not $PythonPath) { $PythonPath = $env:SATELLITE_PYTHON }
    if (-not $PythonPath -and $config) { $PythonPath = $config.python }
    if (-not $PythonPath) { $PythonPath = Join-Path $ProjectRoot 'packaging\runtime\python\python.exe' }
    if (-not $BlenderPath) { $BlenderPath = $env:SATELLITE_BLENDER }
    if (-not $BlenderPath -and $config) { $BlenderPath = $config.blender }
    if (-not $BlenderPath) { $BlenderPath = Join-Path $ProjectRoot 'packaging\runtime\blender\blender.exe' }
    if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) { throw 'Python runtime not found. Set SATELLITE_PYTHON or create var/runtime.json as described in README.' }
    return @{ Python = $PythonPath; Blender = $BlenderPath }
}
