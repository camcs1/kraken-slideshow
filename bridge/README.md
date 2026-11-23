# Kraken bridge: remote control for the slideshow

Controls the slideshow running on the Kraken LCD from Home Assistant, the tray
icon, PowerShell or scripts: next/previous, pick and hold an item, push any
image or video, night mode, and a MilkDrop visualizer that follows the PC's audio.

```
Home Assistant ◀──MQTT──▶ kraken-bridge.js ──ws://127.0.0.1──▶ Kraken page (?kraken=1, inside CAM)
                             ▲        ▲
       KrakenBridge.exe ─────┘        └── UDP audio ◀── kraken-audio.py (only while visualizing)
       (tray app: runs it hidden,
        restarts it, holds MQTT login)
```

The page (served over https from GitHub Pages) opens the WebSocket itself. CAM's
browser allows an https page to reach `localhost`, which is the same route the
nzxt-esc NowPlaying companion uses. The bridge's HTTP/WebSocket port binds to
`127.0.0.1` only. Home Assistant reaches it through your MQTT broker, so nothing
on this PC listens on the network and no process is started per command.

If the bridge isn't running, the slideshow plays as normal. The page retries
quietly, backing off to every 30 seconds.

## Requirements

- Node.js 18 or newer on PATH (no `npm install`; the bridge has no dependencies)
- For the visualizer: Python 3 with `pip install --user soundcard`
- For Home Assistant: an MQTT broker HA uses (e.g. the Mosquitto app) and a login for the bridge
- The updated `index.html` published to GitHub Pages

## Tray app

`KrakenBridge.exe` runs the bridge with no console window, restarts it if it
exits, and shows a round status icon: green when the Kraken page and Home
Assistant are both connected, amber if one isn't, grey if the bridge is down.
Its menu has the current status, quick commands (Next, Hold this, Slideshow,
Visualizer on/off, Next preset), **Home Assistant (MQTT) settings…**, **Open
log**, **Restart bridge** and **Quit**.

Build it (uses the C# compiler that ships with Windows, nothing to install) and
make it start at logon:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Scripts\kraken-slideshow\bridge\install-startup.ps1
```

That builds `KrakenBridge.exe` if needed, adds a Startup-folder shortcut, and
starts it; it replaces any bridge already running. `-Remove` takes the shortcut
out. To rebuild after editing [tray/KrakenTray.cs](tray/KrakenTray.cs), run
[tray/build.ps1](tray/build.ps1).

On first run it asks for the MQTT broker, port, username and password (the
broker and username are prefilled from HASS.Agent if it's installed). Settings
live in `%APPDATA%\KrakenBridge\settings.ini`, with the password encrypted for
your Windows account (DPAPI). The log is `%LOCALAPPDATA%\KrakenBridge\bridge.log`.

Without the tray app you can still run `node kraken-bridge.js` directly; set
`KRAKEN_MQTT_HOST`, `KRAKEN_MQTT_PORT`, `KRAKEN_MQTT_USER` and
`KRAKEN_MQTT_PASSWORD` to enable Home Assistant.

Check that the Kraken page is connected:

```powershell
node C:\Scripts\kraken-slideshow\bridge\kraken-bridge.js status
```

`clients` should be 1 or more, `state` shows what's on the screen and `mqtt`
shows the Home Assistant connection. If `clients` stays 0, restart CAM.

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
| `status` | `/status` | Connected clients, the last state the page reported, audio and MQTT status |
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
| `visualizer on [preset words]` | Start, optionally on a preset: exact name first, else the first containing the words |
| `visualizer next` / `prev` / `random` | Change preset (2.7 s blend) |
| `visualizer res 256` | Internal render size, 128–1024 (default 192; scaled up to the LCD) |
| `visualizer fps 20` | Frame cap, 5–60 (default none) |
| `visualizer off` | Back to the slideshow |
| `presets` (CLI) / `/presets` | Preset names (loaded in the background once the page connects) |

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

## Home Assistant

With MQTT configured, the bridge announces a **Kraken LCD** device through MQTT
discovery. Nothing needs setting up in HA.

| Entity | What it does |
|---|---|
| `button.kraken_lcd_next` / `_prev` / `_hold` / `_slideshow` / `_reload` | The matching command |
| `button.kraken_lcd_viz_next` / `_viz_random` | Change visualizer preset |
| `switch.kraken_lcd_visualizer` | Visualizer on/off |
| `select.kraken_lcd_preset` | Start the visualizer on a chosen preset (all names listed) |
| `select.kraken_lcd_night` | Night mode: `auto` (schedule), `on`, `off` |
| `text.kraken_lcd_pick` | Hold an item by number (1-based, as the Position sensor shows) or name |
| `sensor.kraken_lcd_mode` | `slideshow`, `picked`, `paused`, `remote`, `visualizer`, `disconnected` |
| `sensor.kraken_lcd_position` | `20 / 56`, or the preset and fps in visualizer mode |
| `sensor.kraken_lcd_showing` | Item or preset name |
| `sensor.kraken_lcd_fps` | Visualizer frame rate (diagnostic) |
| `binary_sensor.kraken_lcd_page` | Whether the Kraken page is connected (diagnostic) |
| `image.kraken_lcd_now` | The image on the screen |
| `sensor.kraken_lcd_playlist` | Number of items; the `items` attribute lists each name, URL and type (feeds the picker card) |

State is pushed when it changes, not polled. The device shows unavailable when
the bridge is offline (MQTT last will).

### Picture picker card

`ha/kraken-picker-card.js` is a small dashboard card that shows the playlist as
round thumbnails. Tap one to hold it on the Kraken (this also leaves the
visualizer); the item on screen is outlined, and **Back to slideshow** appears
while one is held. GIFs stay still until hovered, except the one on screen, so
a phone isn't playing fifty animations at once.

Add it once under **Settings → Dashboards → ⋮ → Resources** as a JavaScript
module, straight from GitHub Pages:

```
https://camcs1.github.io/kraken-slideshow/ha/kraken-picker-card.js?v=1
```

then add a card with `type: custom:kraken-picker-card`. Options (all optional):
`title`, `columns` (4), `max_height` (`420px`, or `none`), `animate`
(`current` / `all` / `none`), and the entity IDs if yours differ. After
changing the card file, bump `?v=` on the resource so browsers fetch it again.

**Any command over MQTT.** Publish the command text to
`kraken/<pc name>/command`, e.g. `next`, `pick 5`, `show https://… 20`,
`visualizer on wormhole`. On GAMINGPC, `script.kraken_command` (field
`command`) does this, and the dashboard's **PC** view has a **Kraken LCD**
section built from the entities above.

**Pushing a specific image** (doorbell snapshot, alert graphic): call
`script.kraken_command` with `command: show <url> 20`. The URL must be loadable
by CAM's browser. Watch out for an `http://` Home Assistant URL, which an https
page may refuse to load as mixed content; an https URL is safest.

**Previously** this ran through HASS.Agent (a Custom command per action and
PowerShell sensors). Each command and each sensor poll started a console process,
which flashed a window, so it was replaced by the bridge's own MQTT connection.

## Settings

- Port and host: environment variables `KRAKEN_BRIDGE_PORT` (default 27880) and
  `KRAKEN_BRIDGE_HOST` (default 127.0.0.1); `KRAKEN_AUDIO_PORT` (UDP, default 27881).
- MQTT: `KRAKEN_MQTT_HOST`, `KRAKEN_MQTT_PORT`, `KRAKEN_MQTT_USER`,
  `KRAKEN_MQTT_PASSWORD` (the tray app sets these), `KRAKEN_NODE_ID` (default:
  the PC name; used in topics and entity IDs).
- The page side reads localStorage key `krakenBridgeUrl` (default
  `ws://127.0.0.1:27880/ws`). Set it to `off` to stop the page from connecting.
