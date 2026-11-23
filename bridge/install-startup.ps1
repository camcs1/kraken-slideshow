# Adds (or with -Remove, deletes) a shortcut in your Startup folder that runs
# the Kraken bridge hidden at logon. Nothing runs as admin.
param([switch]$Remove)

$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Kraken Bridge.lnk'

if ($Remove) {
    if (Test-Path $lnk) { Remove-Item $lnk; "Removed $lnk" } else { "No shortcut at $lnk" }
    return
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'node is not on PATH. Install Node.js 18+ first.'
}

$vbs = Join-Path $PSScriptRoot 'start-hidden.vbs'
$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = "$env:WINDIR\System32\wscript.exe"
$sc.Arguments = "`"$vbs`""
$sc.WorkingDirectory = $PSScriptRoot
$sc.Description = 'Kraken Slideshow bridge (ws://127.0.0.1:27880)'
$sc.Save()
"Created $lnk"
"Start it now without logging out: wscript `"$vbs`""
