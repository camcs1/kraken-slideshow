# Adds (or with -Remove, deletes) a Startup-folder shortcut that runs the
# Kraken Bridge tray app at logon. Builds KrakenBridge.exe first if needed.
# Nothing runs as admin.
param([switch]$Remove, [switch]$NoStart)

$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'Kraken Bridge.lnk'

if ($Remove) {
    if (Test-Path $lnk) { Remove-Item $lnk; "Removed $lnk" } else { "No shortcut at $lnk" }
    return
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'node is not on PATH. Install Node.js 18+ first.'
}

$exe = Join-Path $PSScriptRoot 'KrakenBridge.exe'
if (-not (Test-Path $exe)) { & (Join-Path $PSScriptRoot 'tray\build.ps1') }

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = $exe
$sc.WorkingDirectory = $PSScriptRoot
$sc.Description = 'Kraken Bridge tray app (Kraken LCD remote control)'
$sc.Save()
"Created $lnk -> $exe"

if (-not $NoStart -and -not (Get-Process KrakenBridge -ErrorAction SilentlyContinue)) {
    Start-Process $exe
    'Started the tray app (it replaces any bridge already running).'
}
