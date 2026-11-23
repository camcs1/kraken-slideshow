# Prints one value from the bridge for a HASS.Agent PowerShell sensor.
#   -Field mode     slideshow | picked | paused | remote | offline
#   -Field src      URL of what's on the screen (empty when offline)
#   -Field position e.g. "53 / 56", or "<preset> (middle dot) 40 fps" in visualizer mode
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
    'position' {
        if ($s.mode -eq 'visualizer' -and $s.visualizer) {
            # [char]0xB7 = middle dot; a literal would be misread (PS 5.1 reads BOM-less .ps1 as ANSI)
            $t = '{0} {1} {2} fps' -f $s.visualizer.preset, [char]0xB7, $s.visualizer.fps
            $t.Substring(0, [Math]::Min(255, $t.Length))
        } else {
            '{0} / {1}' -f ($s.index + 1), $s.count
        }
    }
}
