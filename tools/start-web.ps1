[CmdletBinding()]
param([switch]$Check)
$ErrorActionPreference = 'Stop'
try {
    $projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
    $uiRoot = Join-Path $projectRoot 'apps\ui'
    $prepareScript = Join-Path $PSScriptRoot 'prepare-web-assets.mjs'
    foreach ($requiredPath in @($prepareScript, (Join-Path $uiRoot 'package.json'), (Join-Path $projectRoot 'assets\models\index.json'))) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) { throw "Required project file missing: $requiredPath" }
    }
    $nodeCandidates = @()
    $systemNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($systemNode) { $nodeCandidates += $systemNode.Source }
    try {
        $runtimePackages = @(Get-AppxPackage -Name 'OpenAI.CodexPrimaryRuntime*' -ErrorAction Stop | Sort-Object Version -Descending)
        foreach ($runtimePackage in $runtimePackages) {
            $nodeCandidates += Join-Path $runtimePackage.InstallLocation 'dependencies\node\bin\node.exe'
        }
    } catch {
        if (-not $systemNode) { Write-Warning "Cannot inspect Codex runtime packages: $($_.Exception.Message)" }
    }
    $nodeExecutable = $null
    foreach ($candidate in ($nodeCandidates | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $nodeVersionText = & $candidate --version
        if ($LASTEXITCODE -ne 0) { continue }
        # Compare the numeric release core; prerelease/build labels are not .NET Version syntax.
        $cleanVersion = ((($nodeVersionText -join "`n").Trim().TrimStart('v')) -split '[-+]')[0]
        $nodeVersion = $null
        if (-not [version]::TryParse($cleanVersion, [ref]$nodeVersion)) { continue }
        if ($nodeVersion -ge [version]'22.18.0') { $nodeExecutable = $candidate; break }
    }
    if (-not $nodeExecutable) { throw 'Node.js 22.18+ was not found. Install Node.js or make an installed Codex primary runtime available. No system settings were changed.' }
    Write-Host "Node: $nodeExecutable ($nodeVersionText)"
    $viteScript = Join-Path $uiRoot 'node_modules\vite\bin\vite.js'
    $dependencyFiles = @('vite\bin\vite.js', 'react\package.json', 'react-dom\package.json', 'three\package.json', '@vitejs\plugin-react\package.json')
    foreach ($dependencyFile in $dependencyFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $uiRoot "node_modules\$dependencyFile") -PathType Leaf)) {
            throw "UI dependencies are missing. In apps\ui run: pnpm install --frozen-lockfile. Install pnpm first if needed. This launcher does not install packages or access the network automatically."
        }
    }
    Push-Location $projectRoot
    try {
        & $nodeExecutable $prepareScript
        if ($LASTEXITCODE -ne 0) { throw 'Local model preparation failed. Restore the local GLB assets matching assets/models/index.json, then retry.' }
    } finally { Pop-Location }
    if ($Check) { Write-Host 'Check passed: runtime, dependencies and verified local model assets are ready.'; exit 0 }
    Write-Host 'Opening http://127.0.0.1:5173 . Keep this window open; press Ctrl+C to stop.'
    Push-Location $uiRoot
    try {
        & $nodeExecutable $viteScript --host 127.0.0.1 --port 5173 --strictPort --open
        if ($LASTEXITCODE -ne 0) { throw 'The local web server stopped with an error. Check whether port 5173 is already in use.' }
    } finally { Pop-Location }
    exit 0
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
