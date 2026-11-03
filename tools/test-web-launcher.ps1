[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testParent = [IO.Path]::GetFullPath((Join-Path $projectRoot 'var'))
$testRoot = Join-Path $testParent ('web-launcher-test-' + [guid]::NewGuid().ToString('N'))
$shell = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop).Source
$utf8 = New-Object Text.UTF8Encoding($false)
$cases = @(
    @{ Name = 'minimum stable'; Versions = @('v22.18.0'); Selected = 0 },
    @{ Name = 'nightly suffix'; Versions = @('v22.18.0-nightly20261103'); Selected = 0 },
    @{ Name = 'release candidate'; Versions = @('v22.18.0-rc.1'); Selected = 0 },
    @{ Name = 'build metadata'; Versions = @('v22.18.0+build.42'); Selected = 0 },
    @{ Name = 'prerelease and build metadata'; Versions = @('v24.0.0-rc.2+build.42'); Selected = 0 },
    @{ Name = 'old candidate fallback'; Versions = @('v22.17.9-nightly', 'v22.18.0'); Selected = 1 },
    @{ Name = 'malformed candidate fallback'; Versions = @('not-a-version', 'v22.18.0'); Selected = 1 },
    @{ Name = 'overflow candidate fallback'; Versions = @('v999999999999999.0.0', 'v22.18.0'); Selected = 1 },
    @{ Name = 'empty candidate fallback'; Versions = @('', 'v22.18.0'); Selected = 1 },
    @{ Name = 'all candidates unsupported'; Versions = @('v22.17.9', 'unreadable'); Selected = -1 }
)
$failures = @()
try {
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    for ($caseIndex = 0; $caseIndex -lt $cases.Count; $caseIndex++) {
        $case = $cases[$caseIndex]
        $candidatePaths = @()
        for ($candidateIndex = 0; $candidateIndex -lt $case.Versions.Count; $candidateIndex++) {
            $candidatePath = Join-Path $testRoot "$caseIndex-$candidateIndex.ps1"
            $versionLiteral = $case.Versions[$candidateIndex].Replace("'", "''")
            # A local command fixture emulates --version and the already-verified asset-preparation step.
            $candidateSource = @'
param([string]$Command)
if ($Command -eq '--version') { Write-Output '__VERSION__'; exit 0 }
if ([IO.Path]::GetFileName($Command) -eq 'prepare-web-assets.mjs') { exit 0 }
throw 'Unexpected launcher command in fixture.'
'@
            [IO.File]::WriteAllText($candidatePath, $candidateSource.Replace('__VERSION__', $versionLiteral), $utf8)
            $candidatePaths += $candidatePath
        }
        $sourceLiterals = @($candidatePaths | ForEach-Object { "[pscustomobject]@{Source = '" + $_.Replace("'", "''") + "'}" }) -join ",`n"
        $launcherLiteral = (Join-Path $PSScriptRoot 'start-web.ps1').Replace("'", "''")
        $wrapperSource = @'
function Get-Command { param($Name, $CommandType, $ErrorAction)
    @(__CANDIDATES__)
}
function Get-AppxPackage { param($Name, $ErrorAction) @() }
& '__LAUNCHER__' -Check
exit $LASTEXITCODE
'@
        $wrapperPath = Join-Path $testRoot "$caseIndex-run.ps1"
        [IO.File]::WriteAllText($wrapperPath, $wrapperSource.Replace('__CANDIDATES__', $sourceLiterals).Replace('__LAUNCHER__', $launcherLiteral), $utf8)
        # Run the production launcher with Windows PowerShell, exactly as start-web.cmd does.
        $output = (& $shell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $wrapperPath 2>&1 | Out-String)
        $exitCode = $LASTEXITCODE
        if ($case.Selected -ge 0) {
            $passed = $exitCode -eq 0 -and $output.Contains("Node: $($candidatePaths[$case.Selected]) ") -and $output.Contains('Check passed:')
        } else {
            $passed = $exitCode -eq 1 -and $output.Contains('Node.js 22.18+ was not found.')
        }
        if ($passed) { Write-Host "PASS: $($case.Name)" }
        else { $failures += $case.Name; Write-Host "FAIL: $($case.Name) (exit $exitCode)`n$output" }
    }
} finally {
    # Delete only this test's unique directory, after resolving and checking its absolute location.
    if (Test-Path -LiteralPath $testRoot) {
        $resolvedTestRoot = (Resolve-Path -LiteralPath $testRoot).ProviderPath
        if (-not $resolvedTestRoot.StartsWith($testParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
            [IO.Path]::GetFileName($resolvedTestRoot) -notlike 'web-launcher-test-*') {
            throw 'Refusing cleanup outside the launcher test directory.'
        }
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
if ($failures.Count) { throw "$($failures.Count) launcher cases failed: $($failures -join ', ')" }
Write-Host "All $($cases.Count) launcher cases passed."
