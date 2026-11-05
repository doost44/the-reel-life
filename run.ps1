# Start the eye and open the setup editor.
#   .\run.ps1               the editor opens in your browser
#   .\run.ps1 -OpenScreens  also opens every screen fullscreen on its monitor
param([switch]$OpenScreens)

$python = Join-Path $env:USERPROFILE ".venvs\reel-life\Scripts\python.exe"
if (-not (Test-Path $python)) {
    Write-Host "No Python environment at $python. See README.md, 'First-time setup'."
    exit 1
}

Set-Location $PSScriptRoot
$eyeArgs = @("-m", "eye", "--open-editor")
if ($OpenScreens) { $eyeArgs += "--open-screens" }
& $python @eyeArgs
