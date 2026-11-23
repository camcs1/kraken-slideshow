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

## HASS.Agent setup

In HASS.Agent, go to **Commands → Add New**. Pick the **PowerShell** type and
use entity type **button**. One command per action:

| Name | Command |
|---|---|
| Kraken Next | `Invoke-RestMethod http://127.0.0.1:27880/next` |
| Kraken Previous | `Invoke-RestMethod http://127.0.0.1:27880/prev` |
| Kraken Pause | `Invoke-RestMethod http://127.0.0.1:27880/pause` |
| Kraken Slideshow | `Invoke-RestMethod http://127.0.0.1:27880/slideshow` |
| Kraken Night On | `Invoke-RestMethod "http://127.0.0.1:27880/night?mode=on"` |
| Kraken Night Auto | `Invoke-RestMethod "http://127.0.0.1:27880/night?mode=auto"` |

They appear in Home Assistant as `button.<pc>_kraken_next` and so on. Press them
from dashboards or automations with `button.press`.

### Picking an image from Home Assistant

HASS.Agent **actions** append an MQTT payload to a command's arguments. That
gives you one command that takes any bridge action as its payload.

1. **Command:** add a **Custom** command named `Kraken`, entity type
   **button**, with the command
   `node "C:\Scripts\kraken-slideshow\bridge\kraken-bridge.js" send`.
   Save it, select it, and click **show mqtt action topic**. Copy the topic
   (something like `homeassistant/button/<pc>/<pc>_kraken/action`).
2. **Playlist sensor:** add a **PowerShell** sensor named `Kraken Playlist`:
   `(node "C:\Scripts\kraken-slideshow\bridge\kraken-bridge.js" playlist names) -join '|'`.
   An HA state is capped at 255 characters, so this suits playlists with short
   names. For long lists, give items short `name` options.
3. **Now showing sensor** (optional): another PowerShell sensor,
   `(Invoke-RestMethod http://127.0.0.1:27880/status).state.mode`.
4. **Home Assistant:** create an `input_select.kraken_pick` helper (any
   placeholder option) and these two automations. Replace the topic with yours,
   and the sensor entity with whatever HASS.Agent named it:

```yaml
# Keep the dropdown's options in sync with the slideshow's playlist
alias: Kraken - refresh picker options
triggers:
  - trigger: state
    entity_id: sensor.mypc_kraken_playlist
actions:
  - action: input_select.set_options
    target:
      entity_id: input_select.kraken_pick
    data:
      options: >
        {{ ['Slideshow'] + states('sensor.mypc_kraken_playlist').split('|') }}
```

```yaml
# Choosing an option shows it on the Kraken; choosing "Slideshow" returns to rotation
alias: Kraken - pick from dropdown
triggers:
  - trigger: state
    entity_id: input_select.kraken_pick
    not_from: unavailable
actions:
  - action: mqtt.publish
    data:
      topic: homeassistant/button/mypc/mypc_kraken/action
      payload: >
        {{ 'slideshow' if trigger.to_state.state == 'Slideshow'
           else 'pick ' ~ trigger.to_state.state }}
```

The same command takes any other action as its payload: `next`, `night on`,
`show https://… 20`, and so on. A plain script that publishes `slideshow` to the
topic makes a good dashboard button for returning to the slideshow.

The bridge accepts the payload either as separate words or as one quoted
argument, so you don't need to escape quotes for names with spaces.

**Pushing a specific image** (doorbell snapshot, alert graphic): make a fixed
command per image, e.g.
`Invoke-RestMethod "http://127.0.0.1:27880/show?url=https://example.com/doorbell.jpg&seconds=20"`.
Or use the `Kraken` action command above with payload `show <url> 20`. The URL
must be loadable by CAM's browser. Watch out for an `http://` Home Assistant
URL, which an https page may refuse to load as mixed content. An https URL is
safest.

**Status sensor** (optional): add a **PowerShell** sensor with
`(Invoke-RestMethod http://127.0.0.1:27880/status).state.src`
to see what's on the screen from Home Assistant.

## Settings

- Port and host: environment variables `KRAKEN_BRIDGE_PORT` (default 27880) and
  `KRAKEN_BRIDGE_HOST` (default 127.0.0.1).
- The page side reads localStorage key `krakenBridgeUrl` (default
  `ws://127.0.0.1:27880/ws`). Set it to `off` to stop the page from connecting.
