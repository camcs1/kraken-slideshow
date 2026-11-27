"use strict";
/*
 * Home Assistant integration for the Kraken bridge over MQTT. No dependencies.
 *
 * Publishes a "Kraken LCD" device through MQTT discovery (buttons, a
 * visualizer switch, night-mode and preset selects, a pick text box, sensors
 * and a now-showing image), pushes state when the page reports a change, and
 * turns HA commands into bridge commands. Nothing is spawned per command.
 *
 * Topics (nodeId = PC name, lower case):
 *   kraken/<nodeId>/status         online/offline (retained, last will)
 *   kraken/<nodeId>/state          JSON snapshot (retained)
 *   kraken/<nodeId>/image_url      URL on screen (retained)
 *   kraken/<nodeId>/command        any bridge command text, e.g. "pick 5", "visualizer next"
 *   kraken/<nodeId>/visualizer/set ON | OFF
 *   kraken/<nodeId>/night/set      auto | on | off
 *   kraken/<nodeId>/preset/set     preset name
 *   kraken/<nodeId>/pick/set       item number (1-based, as the position sensor shows) or name
 */
const net = require("net");

const KEEPALIVE = 30;            // seconds
const NO_PRESET = "—";           // placeholder option until presets are known
// Visualizer preset packs (ids match the page's VIZ_PACKS) and their names in HA.
const GRADE_LABELS = { off: "Off", subtle: "Subtle", strong: "Strong", full: "Full" };
const PACK_LABELS = { default: "Default", extra: "Extra", extra2: "Extra 2", md1: "MilkDrop 1",
                      minimal: "Lightweight", weekly: "Community weekly", all: "All", favorites: "Favourites" };

// Slideshow interval dropdown: preset times, plus the current value if it's something else.
const INTERVAL_PRESETS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const intervalLabel = s => s % 3600 === 0 ? (s === 3600 ? "1 hour" : `${s / 3600} hours`)
  : s % 60 === 0 ? `${s / 60} min` : `${s} s`;
function intervalFromLabel(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|minutes?|h|hours?)?$/i.exec(String(text).trim());
  if (!m) return NaN;
  const u = (m[2] || "s").toLowerCase()[0];
  return Math.round(Number(m[1]) * (u === "h" ? 3600 : u === "m" ? 60 : 1));
}
function intervalOptions(current) {
  const secs = INTERVAL_PRESETS.slice();
  if (Number.isInteger(current) && !secs.includes(current)) { secs.push(current); secs.sort((a, b) => a - b); }
  return secs.map(intervalLabel);
}

module.exports = function startHaMqtt(opts) {
  const { host, port, username, password, nodeId, log, dispatch, textToCommand } = opts;
  const base = `kraken/${nodeId}`;
  const disc = "homeassistant";
  const uid = `kraken_${nodeId}`;

  let sock = null, connected = false, lastError = null;
  let pingTimer = null, retryDelay = 2000, packetId = 1;
  let snap = null, lastStateJson = null, lastImage = null, lastPresetsKey = null, lastPlaylistJson = null;
  let lastIntervalOptsKey = null;

  /* ------------------------------------------------------ HA entities */
  const device = {
    identifiers: [uid],
    name: "Kraken LCD",
    manufacturer: "kraken-slideshow",
    model: `Bridge on ${nodeId.toUpperCase()}`,
  };
  const common = (component, key, name, extra) => Object.assign({
    name,
    unique_id: `${uid}_${key}`,
    default_entity_id: `${component}.kraken_lcd_${key}`,
    device,
    availability_topic: `${base}/status`,
  }, extra);
  const stateTpl = field => `{{ value_json.${field} }}`;

  function discoveryConfigs() {
    const presets = (snap && snap.presets.length) ? snap.presets : [];
    const out = [];
    const button = (key, name, icon, press) => out.push(["button", key, common("button", key, name,
      { icon, command_topic: `${base}/command`, payload_press: press })]);
    button("next", "Next", "mdi:skip-next", "next");
    button("prev", "Previous", "mdi:skip-previous", "prev");
    button("hold", "Hold this", "mdi:pin", "hold");
    button("slideshow", "Slideshow", "mdi:play-circle-outline", "slideshow");
    button("reload", "Reload page", "mdi:refresh", "reload");
    button("viz_next", "Next preset", "mdi:skip-forward-outline", "visualizer next");
    button("viz_random", "Random preset", "mdi:shuffle-variant", "visualizer random");
    button("title_show", "Show track title", "mdi:format-title", "titles show");

    out.push(["switch", "visualizer", common("switch", "visualizer", "Visualizer", {
      icon: "mdi:music-circle",
      command_topic: `${base}/visualizer/set`,
      state_topic: `${base}/state`,
      value_template: "{{ 'ON' if value_json.mode == 'visualizer' else 'OFF' }}",
    })]);
    out.push(["select", "night", common("select", "night", "Night mode", {
      icon: "mdi:weather-night",
      options: ["auto", "on", "off"],
      command_topic: `${base}/night/set`,
      state_topic: `${base}/state`,
      value_template: stateTpl("night_mode"),
    })]);
    out.push(["select", "preset", common("select", "preset", "Visualizer preset", {
      icon: "mdi:palette",
      options: [NO_PRESET, ...presets],
      command_topic: `${base}/preset/set`,
      state_topic: `${base}/state`,
      value_template: stateTpl("preset_option"),
    })]);
    // Visualizer settings (saved on the Kraken page).
    out.push(["select", "viz_pack", common("select", "viz_pack", "Preset pack", {
      icon: "mdi:folder-music",
      options: Object.values(PACK_LABELS),
      command_topic: `${base}/viz_pack/set`,
      state_topic: `${base}/state`,
      value_template: `{{ ${JSON.stringify(PACK_LABELS)}.get(value_json.viz_pack, 'Default') }}`,
    })]);
    out.push(["number", "viz_cycle", common("number", "viz_cycle", "Auto-change preset every", {
      icon: "mdi:timer-sync-outline",
      min: 0, max: 600, step: 5, mode: "box", unit_of_measurement: "s",
      command_topic: `${base}/viz_cycle/set`,
      state_topic: `${base}/state`,
      value_template: stateTpl("viz_cycle"),
    })]);
    out.push(["select", "viz_order", common("select", "viz_order", "Preset order", {
      icon: "mdi:shuffle-variant",
      options: ["random", "sequential"],
      command_topic: `${base}/viz_order/set`,
      state_topic: `${base}/state`,
      value_template: stateTpl("viz_order"),
    })]);
    out.push(["number", "viz_blend", common("number", "viz_blend", "Preset blend time", {
      icon: "mdi:transition",
      min: 0, max: 10, step: 0.5, mode: "slider", unit_of_measurement: "s",
      command_topic: `${base}/viz_blend/set`,
      state_topic: `${base}/state`,
      value_template: stateTpl("viz_blend"),
    })]);
    out.push(["select", "viz_grade", common("select", "viz_grade", "Colour grade", {
      icon: "mdi:palette-swatch-variant",
      options: Object.values(GRADE_LABELS),
      command_topic: `${base}/viz_grade/set`,
      state_topic: `${base}/state`,
      value_template: `{{ ${JSON.stringify(GRADE_LABELS)}.get(value_json.viz_grade, 'Off') }}`,
    })]);
    out.push(["switch", "viz_ontrack", common("switch", "viz_ontrack", "New preset on track change", {
      icon: "mdi:music-note-plus",
      command_topic: `${base}/viz_ontrack/set`,
      state_topic: `${base}/state`,
      value_template: "{{ 'ON' if value_json.viz_ontrack else 'OFF' }}",
    })]);
    out.push(["switch", "viz_fav", common("switch", "viz_fav", "Favourite preset", {
      icon: "mdi:star",
      command_topic: `${base}/viz_fav/set`,
      state_topic: `${base}/state`,
      value_template: "{{ 'ON' if value_json.viz_fav else 'OFF' }}",
      json_attributes_topic: `${base}/state`,
      json_attributes_template: "{{ {'favourites': value_json.viz_favorites, 'names': value_json.viz_favorite_names | default([])} | tojson }}",
    })]);
    out.push(["number", "interval", common("number", "interval", "Slideshow interval", {
      icon: "mdi:timer-outline",
      min: 1, max: 3600, step: 1, mode: "box", unit_of_measurement: "s",
      command_topic: `${base}/interval/set`,
      state_topic: `${base}/state`,
      value_template: stateTpl("interval"),
    })]);
    out.push(["select", "interval_preset", common("select", "interval_preset", "Slideshow interval preset", {
      icon: "mdi:timer-outline",
      options: intervalOptions(snap && snap.interval),
      command_topic: `${base}/interval_preset/set`,
      state_topic: `${base}/state`,
      value_template: stateTpl("interval_option"),
    })]);
    out.push(["select", "titles", common("select", "titles", "Track titles", {
      icon: "mdi:music-note-eighth",
      options: ["visualizer", "always", "off"],
      command_topic: `${base}/titles/set`,
      state_topic: `${base}/state`,
      value_template: stateTpl("titles"),
    })]);
    out.push(["text", "pick", common("text", "pick", "Pick item", {
      icon: "mdi:image-search",
      command_topic: `${base}/pick/set`,
      max: 100,
    })]);

    const sensor = (key, name, icon, field, extra) => out.push(["sensor", key, common("sensor", key, name,
      Object.assign({ icon, state_topic: `${base}/state`, value_template: stateTpl(field) }, extra))]);
    sensor("mode", "Mode", "mdi:monitor-screenshot", "mode", {
      // The picker card highlights the item on screen from this.
      json_attributes_topic: `${base}/state`,
      json_attributes_template: "{{ {'index': value_json.index, 'name': value_json.name, 'view': value_json.view} | tojson }}",
    });
    // Playlist for the picture picker card: state = item count, items as an attribute.
    out.push(["sensor", "playlist", common("sensor", "playlist", "Playlist", {
      icon: "mdi:image-multiple",
      state_topic: `${base}/playlist`,
      value_template: "{{ value_json['items'] | count }}",
      json_attributes_topic: `${base}/playlist`,
      unit_of_measurement: "items",
    })]);
    sensor("position", "Position", "mdi:counter", "position");
    sensor("showing", "Showing", "mdi:image", "name");
    sensor("track", "Now playing", "mdi:music", "track", {
      json_attributes_topic: `${base}/state`,
      json_attributes_template: "{{ {'playing': value_json.track_playing} | tojson }}",
    });
    sensor("fps", "Visualizer fps", "mdi:speedometer", "fps",
      { unit_of_measurement: "fps", state_class: "measurement", entity_category: "diagnostic" });
    out.push(["binary_sensor", "page", common("binary_sensor", "page", "Kraken page connected", {
      device_class: "connectivity",
      entity_category: "diagnostic",
      state_topic: `${base}/state`,
      value_template: "{{ 'ON' if value_json.connected else 'OFF' }}",
    })]);
    out.push(["image", "now", common("image", "now", "Now showing", { url_topic: `${base}/image_url` })]);
    return out;
  }

  function publishDiscovery() {
    for (const [component, key, cfg] of discoveryConfigs()) {
      publish(`${disc}/${component}/${uid}/${key}/config`, JSON.stringify(cfg), true);
    }
    lastPresetsKey = snap ? snap.presets.join("\n") : "";
    lastIntervalOptsKey = intervalOptions(snap && snap.interval).join("\n");
  }

  function publishState(force) {
    if (!connected || !snap) return;
    const { presets, playlist, ...rest } = snap;
    rest.preset_option = presets.includes(snap.preset) ? snap.preset : NO_PRESET;
    rest.interval_option = Number.isInteger(snap.interval) ? intervalLabel(snap.interval) : null;   // null -> "None" = unknown in HA
    // A custom interval needs its own option, announced before the state that uses it.
    if (intervalOptions(snap.interval).join("\n") !== lastIntervalOptsKey) publishDiscovery();
    const json = JSON.stringify(rest);
    if (force || json !== lastStateJson) { publish(`${base}/state`, json, true); lastStateJson = json; }
    // Playlist goes on its own retained topic, only when it changes (and never empty
    // just because the page is briefly disconnected).
    if (playlist.length) {
      const pl = JSON.stringify({ items: playlist });
      if (force || pl !== lastPlaylistJson) { publish(`${base}/playlist`, pl, true); lastPlaylistJson = pl; }
    }
    // Keep the last picture while the visualizer runs (an empty URL is invalid for HA).
    const img = snap.src;
    if (img && (force || img !== lastImage)) { publish(`${base}/image_url`, img, true); lastImage = img; }
    // The preset select's options come from the page; re-announce when they change.
    if (snap.presets.join("\n") !== lastPresetsKey) publishDiscovery();
  }

  /* --------------------------------------------------- HA → bridge */
  function onMessage(topic, payload) {
    const text = payload.toString("utf8").trim();
    if (topic === `${disc}/status`) {
      if (text === "online") { log("mqtt: Home Assistant restarted, re-announcing"); publishDiscovery(); publishState(true); }
      return;
    }
    let cmd = null;
    if (topic === `${base}/command`) cmd = textToCommand(text);
    else if (topic === `${base}/visualizer/set`) cmd = { action: "visualizer", mode: text.toUpperCase() === "ON" ? "on" : "off" };
    else if (topic === `${base}/night/set`) cmd = { action: "night", mode: text.toLowerCase() };
    else if (topic === `${base}/titles/set`) cmd = { action: "titles", mode: text.toLowerCase() };
    else if (topic === `${base}/interval_preset/set`) cmd = { action: "interval", seconds: intervalFromLabel(text) };
    else if (topic === `${base}/interval/set`) cmd = { action: "interval", seconds: Math.round(Number(text)) };
    else if (topic === `${base}/viz_pack/set`) {
      const id = Object.keys(PACK_LABELS).find(k => PACK_LABELS[k] === text) || text.toLowerCase();
      cmd = { action: "visualizer", mode: "pack", value: id };
    }
    else if (topic === `${base}/viz_cycle/set`) cmd = { action: "visualizer", mode: "cycle", value: Number(text) };
    else if (topic === `${base}/viz_grade/set`) cmd = { action: "visualizer", mode: "grade", value: text.trim().toLowerCase() };
    else if (topic === `${base}/viz_order/set`) cmd = { action: "visualizer", mode: "order", value: text.toLowerCase() };
    else if (topic === `${base}/viz_blend/set`) cmd = { action: "visualizer", mode: "blend", value: Number(text) };
    else if (topic === `${base}/viz_fav/set`) cmd = { action: "visualizer", mode: "fav", value: text.toUpperCase() === "ON" ? "on" : "off" };
    else if (topic === `${base}/viz_ontrack/set`) cmd = { action: "visualizer", mode: "ontrack", value: text.toUpperCase() === "ON" ? "on" : "off" };
    else if (topic === `${base}/preset/set`) { if (text && text !== NO_PRESET) cmd = { action: "visualizer", mode: "on", preset: text }; }
    else if (topic === `${base}/pick/set`) {
      if (!text) return;
      cmd = /^\d+$/.test(text) ? { action: "pick", index: Number(text) - 1 } : { action: "pick", name: text };
    }
    if (!cmd) return;
    log(`mqtt <- ${topic.slice(base.length + 1)}: ${text}`);
    dispatch(cmd);
  }

  /* ------------------------------------------------ MQTT 3.1.1 wire */
  const str = s => { const b = Buffer.from(s, "utf8"); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
  function remLen(n) {
    const out = [];
    do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 0x80; out.push(d); } while (n > 0);
    return Buffer.from(out);
  }
  const packet = (type, body) => Buffer.concat([Buffer.from([type]), remLen(body.length), body]);

  function send(buf) { if (sock && !sock.destroyed) sock.write(buf); }

  function publish(topic, payload, retain) {
    if (!connected) return;
    send(packet(0x30 | (retain ? 1 : 0), Buffer.concat([str(topic), Buffer.from(payload, "utf8")])));
  }

  function subscribe(topics) {
    const id = Buffer.alloc(2); id.writeUInt16BE(packetId++ & 0xffff || 1);
    const body = [id];
    for (const t of topics) body.push(str(t), Buffer.from([0]));
    send(packet(0x82, Buffer.concat(body)));
  }

  function connect() {
    lastError = null;
    const s = net.createConnection({ host, port });
    sock = s;
    s.setNoDelay(true);
    let buf = Buffer.alloc(0);

    s.on("connect", () => {
      let flags = 0x02 | 0x04 | 0x20;                       // clean session, will flag, will retain (QoS 0)
      if (username) flags |= 0x80;
      if (password) flags |= 0x40;
      const ka = Buffer.alloc(2); ka.writeUInt16BE(KEEPALIVE);
      const parts = [str("MQTT"), Buffer.from([4, flags]), ka, str(`kraken-bridge-${nodeId}`),
                     str(`${base}/status`), str("offline")];
      if (username) parts.push(str(username));
      if (password) parts.push(str(password));
      send(packet(0x10, Buffer.concat(parts)));
    });

    s.on("data", chunk => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        let mult = 1, len = 0, i = 1, byte;
        do {
          if (i >= buf.length) return;
          byte = buf[i++]; len += (byte & 0x7f) * mult; mult *= 128;
        } while (byte & 0x80);
        if (buf.length < i + len) return;
        const type = buf[0] >> 4, flags = buf[0] & 0x0f, body = buf.subarray(i, i + len);
        buf = buf.subarray(i + len);
        handle(type, flags, body);
      }
    });

    const down = why => {
      if (sock !== s) return;
      sock = null;
      if (connected) log(`mqtt: disconnected (${why})`);
      connected = false;
      clearInterval(pingTimer);
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
    };
    s.on("error", err => { lastError = err.message; down(err.message); });
    s.on("close", () => down("closed"));
  }

  const CONNACK_ERRORS = { 1: "bad protocol version", 2: "client id rejected", 3: "broker unavailable",
                           4: "bad username or password", 5: "not authorised" };

  function handle(type, flags, body) {
    if (type === 2) {                                   // CONNACK
      const rc = body[1];
      if (rc !== 0) {
        lastError = CONNACK_ERRORS[rc] || `refused (${rc})`;
        log(`mqtt: ${host}:${port} refused the connection: ${lastError}`);
        sock.destroy();
        return;
      }
      connected = true; retryDelay = 2000;
      log(`mqtt: connected to ${host}:${port} as ${username || "(anonymous)"}`);
      publish(`${base}/status`, "online", true);
      subscribe([`${base}/command`, `${base}/visualizer/set`, `${base}/night/set`,
                 `${base}/preset/set`, `${base}/pick/set`, `${base}/titles/set`, `${base}/interval/set`, `${base}/interval_preset/set`,
                 `${base}/viz_pack/set`, `${base}/viz_cycle/set`, `${base}/viz_order/set`,
                 `${base}/viz_blend/set`, `${base}/viz_ontrack/set`, `${base}/viz_fav/set`, `${base}/viz_grade/set`, `${disc}/status`]);
      publishDiscovery();
      publishState(true);
      pingTimer = setInterval(() => send(Buffer.from([0xc0, 0])), (KEEPALIVE - 5) * 1000);
    } else if (type === 3) {                            // PUBLISH from broker
      const qos = (flags >> 1) & 3;
      const tlen = body.readUInt16BE(0);
      const topic = body.subarray(2, 2 + tlen).toString("utf8");
      let off = 2 + tlen;
      if (qos > 0) {
        const id = body.subarray(off, off + 2); off += 2;
        send(Buffer.concat([Buffer.from([qos === 1 ? 0x40 : 0x50, 2]), id]));   // PUBACK / PUBREC
      }
      try { onMessage(topic, body.subarray(off)); } catch (e) { log(`mqtt: handler error: ${e.message}`); }
    } else if (type === 6) {                            // PUBREL (QoS 2 from broker) -> PUBCOMP
      send(Buffer.concat([Buffer.from([0x70, 2]), body.subarray(0, 2)]));
    }
    // SUBACK (9), PINGRESP (13): nothing to do
  }

  connect();

  return {
    update(snapshot) { snap = snapshot; publishState(false); },
    status() { return { enabled: true, connected, host, port, user: username || null, error: lastError }; },
  };
};
