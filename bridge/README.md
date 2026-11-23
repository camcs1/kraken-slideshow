# Kraken bridge: remote control for the slideshow

Lets anything on this PC (HASS.Agent, PowerShell, scripts) control the slideshow
running on the Kraken LCD: next/previous, pause, push an image or video, force
night mode.

```
Home Assistant ──MQTT──▶ HASS.Agent ──HTTP──▶ kraken-bridge.js ──ws://127.0.0.1──▶ Kraken page (?kraken=1)
```

The page (served over https from GitHub Pages) opens the WebSocket itself. CAM's
browser allows an https page to reach `localhost`, which is the same route the
nzxt-esc NowPlaying companion uses. The bridge binds to `127.0.0.1` only, so
nothing off this PC can reach it: no token and no firewall rule needed.
HASS.Agent handles the network and authentication side.

If the bridge isn't running, the slideshow plays as normal. The page retries
quietly, backing off to every 30 seconds.

## Requirements

- Node.js 18 or newer on PATH (no `npm install`; the bridge has no dependencies)
- The updated `index.html` published to GitHub Pages

## Run it

```powershell
node C:\Scripts\kraken-slideshow\bridge\kraken-bridge.js
```

To start it hidden at every logon:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Scripts\kraken-slideshow\bridge\install-startup.ps1
```

(`-Remove` takes the shortcut out again.)

Check that the Kraken page is connected:

```powershell
node C:\Scripts\kraken-slideshow\bridge\kraken-bridge.js status
```

`clients` should be 1 or more, and `state.src` shows what's on the screen. If
it stays 0, restart CAM, or wait 30s after starting the bridge.

## Commands

| CLI (`node kraken-bridge.js send …`) | HTTP (`http://127.0.0.1:27880/…`) | Effect |
|---|---|---|
| `next` / `prev` | `/next`, `/prev` | Step through the playlist |
| `pick Doorbell Cam` / `pick 2` | `/pick?name=Doorbell%20Cam`, `/pick?index=2` | Show one playlist item and **hold it** (videos loop) until `slideshow` |
| `hold` | `/hold` | Pick whatever is on the screen right now |
| `slideshow` | `/slideshow` | **Return to the slideshow**, at the spot the rotation was at before the first pick. Also ends a `pause` or an untimed `show` |
| `goto 3` | `/goto?index=3` | Jump to item 3 (0-based) and keep rotating from there |
| `pause` / `resume` | `/pause`, `/resume` | Freeze on the current item / continue (`resume` = `slideshow`) |
| `show <url> [seconds]` | `/show?url=…&seconds=30` | Push any image or video. With seconds, the slideshow comes back afterwards; without, it holds until `next`/`resume` |
| `night on\|off\|auto` | `/night?mode=on` | Force night mode (uses your black/dim setting), or go back to the schedule |
| `reload` | `/reload` | Reload the Kraken page (picks up a newly published `index.html`) |
| `status` | `/status` | Connected clients plus the last state the page reported (`mode` is `slideshow`, `picked`, `paused` or `remote`) |
| `playlist` / `playlist names` | `/playlist`, `/playlist?format=names` | The playlist as JSON, or one name per line |

**Item names** are the item's `name` option if it has one, otherwise the file
name without its extension (`.../Doorbell%20Cam.jpg` → `Doorbell Cam`). Set
`{"name":"Front Door"}` in an item's JSON options to give it a friendlier name.
`pick` matches the exact name first (ignoring case), then any name that
*contains* the text if only one does. Ambiguous or unknown names return an error
listing the valid names.

`POST /command` with a JSON body such as `{"action":"show","url":"…","seconds":20}`
works too.

The status `"error":"Kraken page is not connected"` (HTTP 503) means the bridge
is running but CAM's page hasn't connected.

## MilkDrop visualizer

`visualizer on` replaces the slideshow with a MilkDrop visualizer
([Butterchurn](https://github.com/jberg/butterchurn), 100 presets) reacting to
whatever the PC is playing. Any slideshow command (`slideshow`, `next`,
`pick`…) or `visualizer off` goes back.

| Command | Effect |
|---|---|
| `visualizer on [preset words]` | Start, optionally on the first preset whose name contains the words |
| `visualizer next` / `prev` / `random` | Change preset (2.7 s blend) |
| `visualizer res 256` | Internal render size, 128–1024 (default 192; scaled up to the LCD) |
| `visualizer fps 20` | Frame cap, 5–60 (default none) |
| `visualizer off` | Back to the slideshow |
| `presets` (CLI) / `/presets` | Preset names (after the first `visualizer on`) |

**How the audio gets there.** On `visualizer on` the bridge starts
[kraken-audio.py](kraken-audio.py), which records the default output device
with WASAPI loopback and sends ~60 UDP packets a second to the bridge on port
27881. The bridge forwards each one to the page as a binary WebSocket frame,
dropping rather than queueing if the page falls behind. The helper is stopped
when the page leaves visualizer mode or disconnects, and it exits on its own if
the bridge dies. It needs Python with `pip install --user soundcard`
(`KRAKEN_PYTHON` overrides the interpreter).

**Performance.** CAM's browser renders WebGL in software (SwiftShader, on the
CPU), so the visualizer costs CPU in proportion to its pixel count. CAM also
ticks animation frames at about 40 Hz, so a frame cap only skips whole frames
(a 30 cap gives 20 fps). Measured on GAMINGPC, whole CAM process:

| Setting | fps | CAM CPU |
|---|---|---|
| Slideshow (baseline) | n/a | ~0.65 core |
| 192 px (default) | 40 | ~1.5–2 cores |
| 256 px | 40 | ~3.4 cores |
| 256 px, cap 30 | 20 | ~2.3 cores |
| 320 px | 40 | ~4 cores |

Night mode set to *black* pauses rendering entirely.

## HASS.Agent setup

This is the setup running on GAMINGPC. HASS.Agent **actions** append an MQTT
payload to a command's arguments, so one command handles every bridge action.

**Command.** Add a **Custom** command named `GAMINGPC_Kraken`, entity type
**button**, with the command:

```
C:\Scripts\kraken-slideshow\bridge\kraken.cmd
```

It has to be the `.cmd` wrapper, a single path with no arguments. HASS.Agent
wraps the whole configured command in quotes before appending the payload, so
`node "...\kraken-bridge.js" send` becomes `"node "..." send" next`, which
Windows can't run. Its action topic is
`homeassistant/button/GAMINGPC/GAMINGPC_Kraken/action` (the **show mqtt action
topic** button shows it).

**Sensors.** Three **PowerShell** sensors, every 10 seconds, using
[kraken-sensor.ps1](kraken-sensor.ps1):

| Sensor | Query | Example state |
|---|---|---|
| `GAMINGPC_kraken_mode` | `& 'C:\Scripts\kraken-slideshow\bridge\kraken-sensor.ps1' -Field mode` | `slideshow`, `picked`, `paused`, `remote`, `offline` |
| `GAMINGPC_kraken_position` | `... -Field position` | `20 / 56` |
| `GAMINGPC_kraken_src` | `... -Field src` | URL of what's on the screen |

A playlist-names sensor doesn't work for long playlists: HA caps a state at 255
characters, and 56 Reddit-style IDs is about 800.

**Home Assistant** (created through HA-MCP):

- `script.kraken_command`: field `command`, publishes it to the action topic
  (mode `queued`). Every control calls this, e.g. `command: next`.
- `input_text.kraken_pick` plus `automation.kraken_pick_from_text_box`: type a
  number (1-based, as the position sensor shows) or an item name, and that item
  is held. The box clears itself afterwards.
- Overview dashboard, **PC** view, **Kraken LCD** section: now-showing preview,
  Previous / Hold this / Next / Slideshow / Night on / Night auto / Reload /
  Visualizer / Next preset / Random preset buttons, and the pick box. In
  visualizer mode the position sensor shows the preset name and fps.

**Pushing a specific image** (doorbell snapshot, alert graphic): make a fixed
command per image, e.g.
`Invoke-RestMethod "http://127.0.0.1:27880/show?url=https://example.com/doorbell.jpg&seconds=20"`.
Or call `script.kraken_command` with `command: show <url> 20`. The URL
must be loadable by CAM's browser. Watch out for an `http://` Home Assistant
URL, which an https page may refuse to load as mixed content. An https URL is
safest.

## Settings

- Port and host: environment variables `KRAKEN_BRIDGE_PORT` (default 27880) and
  `KRAKEN_BRIDGE_HOST` (default 127.0.0.1).
- The page side reads localStorage key `krakenBridgeUrl` (default
  `ws://127.0.0.1:27880/ws`). Set it to `off` to stop the page from connecting.
