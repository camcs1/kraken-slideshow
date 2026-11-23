# Now-playing helper for the Kraken bridge.
#
# Reads Windows' media session (Global System Media Transport Controls: Spotify,
# browsers, foobar, etc.) and prints one JSON line whenever the track or its play
# state changes:  {"title":"…","artist":"…","album":"…","playing":true,"app":"Spotify.exe"}
# An empty title means nothing is playing. Exits when the process -ParentPid goes away.
#
# Started by kraken-bridge.js with no window; run by hand to test (Ctrl+C to stop):
#   powershell -NoProfile -ExecutionPolicy Bypass -File bridge\kraken-nowplaying.ps1
param([int]$ParentPid = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]

# WinRT async -> .NET Task, then wait (PowerShell 5.1 has no await).
$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Wait-WinRT($op, [Type]$resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  if (-not $task.Wait(3000)) { throw "WinRT call timed out" }
  $task.Result
}

$mgrType   = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$manager   = Wait-WinRT ($mgrType::RequestAsync()) $mgrType

# Quit when the bridge exits (a stdin-EOF check doesn't work reliably in PowerShell 5.1).
$parent = if ($ParentPid) { Get-Process -Id $ParentPid -ErrorAction SilentlyContinue } else { $null }
if ($ParentPid -and -not $parent) { exit 0 }

$last = $null
while ($true) {
  if ($parent -and $parent.HasExited) { break }
  $info = [ordered]@{ title = ''; artist = ''; album = ''; playing = $false; app = '' }
  try {
    $s = $manager.GetCurrentSession()
    if ($s) {
      $p = Wait-WinRT ($s.TryGetMediaPropertiesAsync()) $propsType
      $info.title  = [string]$p.Title
      $info.artist = [string]$p.Artist
      $info.album  = [string]$p.AlbumTitle
      $info.playing = ($s.GetPlaybackInfo().PlaybackStatus -eq 'Playing')
      $info.app    = [string]$s.SourceAppUserModelId
    }
  } catch { }   # a session can vanish mid-read; try again next tick
  $json = $info | ConvertTo-Json -Compress
  if ($json -ne $last) { [Console]::Out.WriteLine($json); [Console]::Out.Flush(); $last = $json }
  Start-Sleep -Milliseconds 700
}
