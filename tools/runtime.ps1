function Get-StudioDesktopBuildDirectory {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)
    [xml]$project = Get-Content -LiteralPath (Join-Path $ProjectRoot 'apps\desktop\SatelliteStudio.Desktop.csproj') -Raw
    $version = [string]$project.Project.PropertyGroup.Version
    if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Desktop project version is invalid.' }
    return Join-Path $ProjectRoot "var\build\desktop-$version"
}

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
