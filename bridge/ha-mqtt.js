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

module.exports = function startHaMqtt(opts) {
  const { host, port, username, password, nodeId, log, dispatch, textToCommand } = opts;
  const base = `kraken/${nodeId}`;
  const disc = "homeassistant";
  const uid = `kraken_${nodeId}`;

  let sock = null, connected = false, lastError = null;
  let pingTimer = null, retryDelay = 2000, packetId = 1;
  let snap = null, lastStateJson = null, lastImage = null, lastPresetsKey = null, lastPlaylistJson = null;

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
  }

  function publishState(force) {
    if (!connected || !snap) return;
    const { presets, playlist, ...rest } = snap;
    rest.preset_option = presets.includes(snap.preset) ? snap.preset : NO_PRESET;
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
                 `${base}/preset/set`, `${base}/pick/set`, `${base}/titles/set`, `${disc}/status`]);
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
