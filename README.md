# Kraken Media Slideshow

A custom media slideshow for the **NZXT Kraken LCD**, running through NZXT CAM's
**Web Integration**. It plays images (`png`, `jpg`, `gif`, `webp`) and video
(`mp4`, `webm`) with intervals, scheduling, night mode and cropping tuned for the
Kraken's round screen.

An optional local **bridge**, run by a small **tray app**, adds remote control
(native Home Assistant entities over MQTT, the tray menu, or PowerShell) and a
**MilkDrop music visualizer** that reacts to whatever the PC is playing.

---

## Features

### Slideshow
- **Configure UI**: click **Configure** in CAM to open the editor.
- **Drag-and-drop playlist**: add, remove and reorder media URLs.
- **Per-item options** (JSON after the URL):
  - Images/GIFs: `{"seconds": 45}` for a custom duration
  - Videos: `{"loop": true, "maxSeconds": 8}`
  - Scheduled: `{"at": "16:20"}` shows it at 4:20 PM daily; add `"only": true` to keep it out of normal rotation
  - Naming: `{"name": "Front Door"}` gives it a friendly name for remote picking
- **Global options**: image interval and video max length, GIF order scrambling,
  night mode (black or dim, by the Kraken browser's local time), `contain`/`cover`,
  background colour, circular mask, circle padding, ring border, zoom, X/Y offset
  and rotation.
- **Live preview** inside Configure, using your unsaved settings.

### Remote control (optional, via the bridge)
- Next / previous, jump to an item, pause and resume.
- **Pick** an item by name or number and hold it, or **hold** whatever is on
  screen now, then return to the **slideshow** where it left off.
- **Show** any image or video URL, for a set time or until dismissed.
- Force night mode on/off, or back to its schedule.
- Status: what's on screen, mode and position.

### MilkDrop visualizer (optional, via the bridge)
- MilkDrop presets rendered with [Butterchurn](https://github.com/jberg/butterchurn)
  (100 presets), driven by the PC's system audio.
- Next / previous / random preset, or start on a preset by name.
- Adjustable render size and frame cap, because CAM renders WebGL on the CPU.
- **Track titles**: the song title pops up and fades when the track changes,
  like MilkDrop, read from Windows' media controls.

---

## How it works

```
                         ┌───────────── NZXT CAM ─────────────┐
                         │  Kraken browser (?kraken=1) ── LCD  │
GitHub Pages index.html ─┤  Configure browser (editor)         │
                         └──────────────┬──────────────────────┘
                                        │ ws://127.0.0.1:27880 (optional)
Home Assistant ◀──MQTT──▶ bridge (node) ◀─UDP─ audio helper (python, visualizer only)
                     PowerShell ─HTTP─┘ ▲
                    tray app (KrakenBridge.exe) runs and supervises it
```

- CAM opens **two browser instances** per integration: the **Kraken browser**
  (with `?kraken=1`) draws on the pump screen, and the **Configuration browser**
  shows the editor. Both share `localStorage`, so saved settings reach the screen
  straight away.
- For remote control, the Kraken page connects out to a small bridge on the same
  PC. CAM's browser allows an https page to reach `localhost`, so the page can
  stay on GitHub Pages. The bridge listens on `127.0.0.1` only and reaches Home
  Assistant through your MQTT broker. Without it the slideshow plays exactly as
  normal.

---

## Installation

### Slideshow
1. Fork or copy this repository (`index.html` and `.nojekyll` are all the page needs).
2. Enable GitHub Pages: **Settings → Pages → Branch → main → / (root)**.
3. In NZXT CAM → **Lighting → Kraken → LCD Display → Web Integration**, set the URL to:
   ```
   https://YOURUSER.github.io/kraken-slideshow/index.html
   ```

### Bridge and tray app (remote control and visualizer)
Requires **Node.js 18+**. The visualizer also needs **Python 3** with
`pip install --user soundcard`. Home Assistant control needs an MQTT broker (such
as the Mosquitto app) and a login for the bridge.

This builds the tray app with the C# compiler built into Windows, makes it start
at logon, and starts it:

```powershell
powershell -ExecutionPolicy Bypass -File bridge\install-startup.ps1
```

On first run it asks for the MQTT broker and login; the password is stored
encrypted for your Windows account. The tray icon turns green once the Kraken
page and Home Assistant are both connected.

Check from the command line (`clients` should be 1):

```powershell
node bridge\kraken-bridge.js status
```

Full command reference and setup details: [bridge/README.md](bridge/README.md).

---

## Usage

### Editing the playlist
1. In CAM, click the integration's **Configure** button.
2. Add media URLs, with optional per-item JSON, and drag to reorder.
3. Adjust global options (intervals, scaling, night mode, offsets…).
4. **Enter Edit Mode** to test the selected item live with unsaved settings.
5. **Save**. The Kraken browser picks up the new settings automatically.

### Remote commands
Any of these works with `node bridge\kraken-bridge.js send …`, as an HTTP call
to `http://127.0.0.1:27880/…`, or published over MQTT to `kraken/<pc name>/command`:

| Command | Effect |
|---|---|
| `next` / `prev` | Step through the playlist |
| `pick 12` / `pick Front Door` | Hold item 12 (0-based) or the item with that name |
| `hold` | Hold whatever is on screen now |
| `slideshow` | Back to rotation, where it was before the pick |
| `show <url> [seconds]` | Show any image or video |
| `night on` / `off` / `auto` | Force night mode, or follow the schedule |
| `visualizer on [preset]` | Start the MilkDrop visualizer |
| `visualizer next` / `prev` / `random` | Change preset |
| `visualizer res 256` / `fps 20` | Tune render size / frame cap |
| `titles visualizer` / `always` / `off` / `show` | When the track title pops up on screen |
| `reload` | Reload the Kraken page (picks up a new `index.html`) |

### Home Assistant
Once the tray app has an MQTT login, a **Kraken LCD** device appears in Home
Assistant by itself (MQTT discovery): buttons for next/previous/hold/slideshow,
a visualizer switch, preset and night-mode dropdowns, a pick-by-number box,
mode/position/showing sensors and a **Now showing** image. A custom
**picker card** (`ha/kraken-picker-card.js`) shows the playlist as thumbnails
you tap to put on the screen. State is pushed the
moment it changes, and nothing is launched on the PC per command, so no console
windows flash. Entity list and details: [bridge/README.md](bridge/README.md#home-assistant).

### Visualizer performance
CAM's browser renders WebGL in software (on the CPU), so the visualizer's cost
scales with its render size. Measured on one PC: the slideshow alone used about
0.65 of a CPU core; the visualizer at the default 192 px and 40 fps used about
1.5–2 cores, and about 4 at 320 px. CAM only produces about 40 frames a second,
so a frame cap skips whole frames (a cap of 30 gives 20 fps). Night mode set to
black pauses rendering.

---

## Example playlist entries
```
https://www.gstatic.com/webp/gallery/1.webp
https://media.giphy.com/media/l0HlQ7LRal8X9sWzO/giphy.gif
https://example.com/clip.mp4 {"loop":true,"maxSeconds":10}
https://example.com/image2.jpg {"seconds":60}
https://example.com/snoop.jpg {"at":"16:20","only":true}
https://example.com/door.jpg {"name":"Front Door"}
```

---

## Notes & tips
- **Circle padding** (default 4%) keeps content off the very edge of the round LCD.
- **Zoom and offsets** help centre subjects inside the circle.
- **Night mode** uses the local time of the browser running on the Kraken. The
  editor shows whether it would be active now; Edit Mode bypasses the overlay so
  you can still see what you're editing.
- The **Preview** inside Configure is only for you; the Kraken keeps running its
  own browser instance.
- Settings live in **localStorage** on each PC. Moving the page to a different
  URL starts with an empty playlist (use export/import in Configure).
- The bridge and visualizer helper only accept connections from the same PC.
