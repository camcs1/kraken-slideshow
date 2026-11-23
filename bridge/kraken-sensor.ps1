# Prints one value from the bridge for a HASS.Agent PowerShell sensor.
#   -Field mode     slideshow | picked | paused | remote | offline
#   -Field src      URL of what's on the screen (empty when offline)
#   -Field position e.g. "53 / 56"
param([ValidateSet('mode', 'src', 'position')][string]$Field = 'mode')

try {
    $s = (Invoke-RestMethod -Uri 'http://127.0.0.1:27880/status' -TimeoutSec 3).state
} catch {
    $s = $null
}

if (-not $s) {
    if ($Field -eq 'mode') { 'offline' } else { '' }
    return
}

switch ($Field) {
    'mode'     { $s.mode }
    'src'      { "$($s.src)".Substring(0, [Math]::Min(255, "$($s.src)".Length)) }
    'position' { '{0} / {1}' -f ($s.index + 1), $s.count }
}
