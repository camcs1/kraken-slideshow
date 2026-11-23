#!/usr/bin/env node
/*
 * Kraken Slideshow bridge — zero dependencies (Node 18+).
 *
 * The Kraken page (?kraken=1, running inside NZXT CAM) connects to
 *   ws://127.0.0.1:27880/ws
 * and this process relays commands to it. Commands come in over plain HTTP on
 * the same port, from HASS.Agent, PowerShell, or this script's CLI mode.
 *
 * Binds to 127.0.0.1 only: nothing off this PC can reach it.
 *
 * Run the server:   node kraken-bridge.js
 * Send a command:   node kraken-bridge.js send next
 *                   node kraken-bridge.js send show https://example.com/a.jpg 30
 *                   node kraken-bridge.js send night on|off|auto
 *                   node kraken-bridge.js send pick Doorbell Cam   (name or index; holds it)
 *                   node kraken-bridge.js send hold                 (hold what's showing now)
 *                   node kraken-bridge.js send slideshow            (back to rotation)
 *                   node kraken-bridge.js send visualizer on [preset words]
 *                   node kraken-bridge.js send visualizer next|prev|random|off
 *                   node kraken-bridge.js send visualizer res 480
 *                   node kraken-bridge.js send visualizer pack default|extra|extra2|md1|minimal|weekly|all
 *                   node kraken-bridge.js send visualizer cycle 30   (seconds; 0 = off)
 *                   node kraken-bridge.js send visualizer order random|sequential
 *                   node kraken-bridge.js send visualizer blend 2.7
 *                   node kraken-bridge.js send visualizer ontrack on|off
 *                   node kraken-bridge.js send visualizer fav [on|off|toggle]   (current preset)
 *                   node kraken-bridge.js send titles visualizer|always|off|show
 *                   node kraken-bridge.js status
 *                   node kraken-bridge.js presets
 *                   node kraken-bridge.js playlist [names]
 *
 * Words after the action are joined with spaces, so HASS.Agent can append an
 * MQTT action payload like "pick Doorbell Cam" to the command "... send".
 */
"use strict";

const http = require("http");
const crypto = require("crypto");
const dgram = require("dgram");
const path = require("path");
const { spawn } = require("child_process");

const HOST = process.env.KRAKEN_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.KRAKEN_BRIDGE_PORT || 27880);
const AUDIO_PORT = Number(process.env.KRAKEN_AUDIO_PORT || 27881);       // UDP from kraken-audio.py
const PYTHON = process.env.KRAKEN_PYTHON || "python";
const ACTIONS = new Set(["next", "prev", "pause", "resume", "slideshow", "pick", "hold", "show", "goto", "night", "reload", "visualizer", "titles"]);
const VIZ_MODES = ["on", "off", "next", "prev", "random", "res", "fps", "pack", "cycle", "order", "blend", "ontrack", "fav"];
const VIZ_PACKS = ["default", "extra", "extra2", "md1", "minimal", "weekly", "all", "favorites"];
const TITLE_MODES = ["visualizer", "always", "off", "show"];   // when the page pops the track title

/* ------------------------------------------------------------------ CLI */
if (["send", "status", "playlist", "presets"].includes(process.argv[2])) {
  runCli(process.argv.slice(2)).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
} else {
  startServer();
}

function cliArgsToCommand([action, ...rest]) {
  // HASS.Agent may hand the whole payload over as one argument ("pick Foo Bar").
  if (action && action.includes(" ") && !rest.length) [action, ...rest] = action.trim().split(/\s+/);
  action = (action || "").toLowerCase();
  const text = rest.join(" ").trim();
  switch (action) {
    case "show":  return { action, url: rest[0], seconds: rest[1] ? Number(rest[1]) : undefined };
    case "goto":  return { action, index: Number(rest[0]) };
    case "pick":  return /^\d+$/.test(text) ? { action, index: Number(text) } : { action, name: text };
    case "night": return { action, mode: (rest[0] || "auto").toLowerCase() };
    case "titles": return { action, mode: (rest[0] || "show").toLowerCase() };
    case "visualizer": {
      const mode = (rest[0] || "on").toLowerCase();
      const arg = rest.slice(1).join(" ").trim();
      if (mode === "res" || mode === "fps" || mode === "cycle" || mode === "blend") return { action, mode, value: Number(arg) };
      if (mode === "pack" || mode === "order" || mode === "ontrack") return { action, mode, value: arg.toLowerCase() };
      if (mode === "fav") return { action, mode, value: (arg || "toggle").toLowerCase() };
      return arg ? { action, mode, preset: arg } : { action, mode };
    }
    default:      return { action };
  }
}

async function runCli(argv) {
  const base = `http://${HOST}:${PORT}`;
  let res;
  if (argv[0] === "status") {
    res = await fetch(`${base}/status`);
  } else if (argv[0] === "playlist") {
    res = await fetch(`${base}/playlist${argv[1] === "names" ? "?format=names" : ""}`);
  } else if (argv[0] === "presets") {
    res = await fetch(`${base}/presets`);
  } else {
    res = await fetch(`${base}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cliArgsToCommand(argv.slice(1))),
    });
  }
  const text = await res.text();
  console.log(text);
  if (!res.ok) process.exit(1);
}

/* --------------------------------------------------------------- server */
function startServer() {
  // socket -> { state, playlist, seen } as reported by that page. Kept per
  // connection so a second page (a test tab) can't overwrite the Kraken's data,
  // and a page's data disappears when it disconnects.
  const clients = new Map();

  // Report state/playlist from the page that spoke most recently, as a pair.
  function primary() {
    let best = null;
    for (const info of clients.values()) {
      if (info.state && (!best || info.seen > best.seen)) best = info;
    }
    return { lastState: best ? best.state : null, playlist: best ? best.playlist : null,
             caps: best ? best.caps : null, presets: best ? best.presets : null };
  }

  /* --- Audio for the visualizer ---------------------------------------
     kraken-audio.py captures system audio and sends 2048-byte UDP datagrams
     here; each one goes to the pages as a binary WebSocket frame. The helper
     only runs while the page is in visualizer mode. */
  let audioProc = null;
  let audioStartedAt = 0;
  let audioPackets = 0, audioRate = 0;

  function startAudio() {
    if (audioProc) return;
    const script = path.join(__dirname, "kraken-audio.py");
    const proc = spawn(PYTHON, [script, "--port", String(AUDIO_PORT)], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    audioProc = proc;
    audioStartedAt = Date.now();
    log(`audio helper started (pid ${proc.pid})`);
    const relayLog = d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => log(`audio: ${l}`));
    proc.stdout.on("data", relayLog);
    proc.stderr.on("data", relayLog);
    proc.on("error", err => log(`audio helper failed to start: ${err.message}`));
    proc.on("exit", code => {
      log(`audio helper exited (${code})`);
      if (audioProc === proc) audioProc = null;
    });
  }

  function stopAudio() {
    const proc = audioProc;
    if (!proc) return;
    audioProc = null;
    try { proc.stdin.end(); } catch {}            // the helper exits on stdin EOF
    setTimeout(() => { if (proc.exitCode === null) proc.kill(); }, 2000).unref();
  }

  const udp = dgram.createSocket("udp4");
  udp.on("message", msg => {
    audioPackets++;
    const frame = encodeFrame(msg, 0x2);
    for (const s of clients.keys()) {
      // Never queue audio: if a page is behind, drop this frame for it.
      if (s.writableLength < 64 * 1024) s.write(frame);
    }
  });
  udp.on("error", err => log(`audio UDP error: ${err.message}`));
  udp.bind(AUDIO_PORT, "127.0.0.1");
  setInterval(() => { audioRate = audioPackets / 5; audioPackets = 0; }, 5000).unref();

  /* --- Now playing ----------------------------------------------------
     kraken-nowplaying.ps1 reads Windows' media session and prints a JSON line
     per track or play-state change. It runs while a page is connected; the
     page pops the title on screen (MilkDrop-style) and HA gets a sensor. */
  let npProc = null, npRetry = null, npFails = 0;
  let nowPlaying = { title: "", artist: "", album: "", playing: false, app: "" };

  function startNowPlaying() {
    if (npProc || npRetry) return;
    const script = path.join(__dirname, "kraken-nowplaying.ps1");
    const proc = spawn("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-ParentPid", String(process.pid)],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    npProc = proc;
    const startedAt = Date.now();
    log(`now-playing helper started (pid ${proc.pid})`);
    let pending = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", d => {
      pending += d;
      let nl;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!line) continue;
        try {
          const np = JSON.parse(line);
          const trackChanged = np.title !== nowPlaying.title || np.artist !== nowPlaying.artist;
          nowPlaying = { title: np.title || "", artist: np.artist || "", album: np.album || "", playing: !!np.playing, app: np.app || "" };
          broadcast(clients, { type: "nowplaying", ...nowPlaying, changed: trackChanged });
          haUpdate();
        } catch { /* ignore junk */ }
      }
    });
    proc.stderr.on("data", d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => log(`now-playing: ${l}`)));
    proc.on("error", err => log(`now-playing helper failed to start: ${err.message}`));
    proc.on("exit", code => {
      if (npProc !== proc) return;            // stopped on purpose
      npProc = null;
      log(`now-playing helper exited (${code})`);
      // Restart while pages are connected, backing off if it keeps dying.
      npFails = Date.now() - startedAt < 30000 ? npFails + 1 : 0;
      if (clients.size) {
        npRetry = setTimeout(() => { npRetry = null; if (clients.size) startNowPlaying(); }, Math.min(60000, 2000 * 2 ** npFails));
        npRetry.unref();
      }
    });
  }

  function stopNowPlaying() {
    if (npRetry) { clearTimeout(npRetry); npRetry = null; }
    const proc = npProc;
    if (!proc) return;
    npProc = null;
    try { proc.kill(); } catch {}
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || HOST}`);
    const { lastState, playlist, caps, presets } = primary();
    try {
      if (url.pathname === "/status") {
        return json(res, 200, { clients: clients.size, state: lastState, caps, nowPlaying, nowPlayingHelper: !!npProc,
                                audio: { running: !!audioProc, packetsPerSec: audioRate },
                                mqtt: ha ? ha.status() : { enabled: false } });
      }
      if (url.pathname === "/presets") {
        if (!presets) return json(res, 503, { error: "visualizer presets not loaded yet (turn the visualizer on once)" });
        return json(res, 200, { count: presets.length, names: presets });
      }
      if (url.pathname === "/playlist") {
        if (!playlist) return json(res, 503, { error: "Kraken page has not reported its playlist yet" });
        if (url.searchParams.get("format") === "names") {
          // One name per line, rotation items only: easy to feed an input_select.
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          return res.end(playlist.map(p => p.name).join("\n"));
        }
        return json(res, 200, { items: playlist });
      }

      let cmd = null;
      if (url.pathname === "/command" && req.method === "POST") {
        cmd = JSON.parse((await readBody(req)) || "{}");
      } else if (ACTIONS.has(url.pathname.slice(1))) {
        // GET/POST /next, /show?url=...&seconds=..., /night?mode=on — handy from scripts
        cmd = { action: url.pathname.slice(1) };
        for (const [k, v] of url.searchParams) cmd[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
      } else {
        return json(res, 404, { error: "not found" });
      }
      const r = dispatch(cmd);
      json(res, r.status, r.body);
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  });

  // One path for every command source (HTTP, CLI, MQTT): validate, resolve
  // names against the page's playlist, manage the audio helper, send.
  function dispatch(cmd) {
    const { lastState, playlist } = primary();
    const problem = validate(cmd);
    if (problem) return { status: 400, body: { error: problem } };
    if (!clients.size) return { status: 503, body: { error: "Kraken page is not connected" } };

    // "hold" = pick whatever the page last reported it was showing.
    if (cmd.action === "hold") {
      if (!lastState || !Number.isInteger(lastState.index)) return { status: 503, body: { error: "Kraken page has not reported what it is showing yet" } };
      cmd = { action: "pick", index: lastState.index };
    }
    if (cmd.action === "pick") {
      const hit = resolvePick(playlist, cmd);
      if (hit.error) return { status: hit.status, body: { error: hit.error, names: playlist ? playlist.map(p => p.name) : undefined } };
      cmd = { action: "pick", index: hit.item.index, name: hit.item.name };
    }

    if (cmd.action === "visualizer") {
      if (cmd.mode === "off") stopAudio();
      else if (!["res", "fps", "pack", "cycle", "order", "blend", "ontrack", "fav"].includes(cmd.mode)) startAudio();   // settings don't start it
    }

    broadcast(clients, cmd);
    log(`-> ${JSON.stringify(cmd)} (${clients.size} client${clients.size === 1 ? "" : "s"})`);
    return { status: 200, body: { ok: true, sent: cmd, clients: clients.size } };
  }

  /* --- Home Assistant over MQTT (optional) -----------------------------
     Enabled when KRAKEN_MQTT_HOST is set (the tray app passes it, with the
     password, in the environment). */
  const ha = process.env.KRAKEN_MQTT_HOST
    ? require("./ha-mqtt")({
        host: process.env.KRAKEN_MQTT_HOST,
        port: Number(process.env.KRAKEN_MQTT_PORT || 1883),
        username: process.env.KRAKEN_MQTT_USER || undefined,
        password: process.env.KRAKEN_MQTT_PASSWORD || undefined,
        nodeId: (process.env.KRAKEN_NODE_ID || require("os").hostname()).toLowerCase().replace(/[^a-z0-9_]/g, "_"),
        log,
        dispatch: c => {
          const r = dispatch(c);
          if (r.status !== 200) log(`mqtt command failed: ${r.body.error}`);
          return r;
        },
        textToCommand: text => cliArgsToCommand(String(text).trim().split(/\s+/)),
      })
    : null;
  delete process.env.KRAKEN_MQTT_PASSWORD;

  // Everything HA shows, derived from the page's latest report.
  function snapshot() {
    const { lastState: s, presets, playlist } = primary();
    const v = s && s.visualizer;
    const vizOn = !!(s && s.mode === "visualizer");
    return {
      connected: clients.size > 0,
      mode: s ? s.mode : "disconnected",
      position: !s ? null : vizOn ? `${v.preset} · ${v.fps} fps` : `${s.index + 1} / ${s.count}`,
      name: s ? s.name : null,
      index: s ? s.index : null,
      src: s && !vizOn ? s.src : null,
      view: s && !vizOn ? (s.view || null) : null,   // fit/bg/zoom/rotation/offset the page drew with
      night_mode: !s ? "auto" : s.nightOverride === true ? "on" : s.nightOverride === false ? "off" : "auto",
      night: !!(s && s.night),
      preset: v ? v.preset : null,
      fps: vizOn ? v.fps : 0,
      presets: presets || [],
      titles: s && s.titles ? s.titles : "visualizer",
      viz_pack: v && v.pack ? v.pack : "default",
      viz_cycle: v && typeof v.cycle === "number" ? v.cycle : 0,
      viz_order: v && v.order ? v.order : "random",
      viz_blend: v && typeof v.blend === "number" ? v.blend : 2.7,
      viz_ontrack: !!(v && v.onTrack),
      viz_fav: !!(v && v.favorite),
      viz_favorites: v && typeof v.favorites === "number" ? v.favorites : 0,
      track: nowPlaying.title ? (nowPlaying.artist ? `${nowPlaying.artist} – ${nowPlaying.title}` : nowPlaying.title) : "",
      track_playing: nowPlaying.playing,
      playlist: (playlist || []).map(p => ({ name: p.name, src: p.src, type: p.type })),
    };
  }
  const haUpdate = () => { if (ha) ha.update(snapshot()); };
  haUpdate();   // so HA has a state ("disconnected") before the page connects

  server.on("upgrade", (req, socket) => {
    if (new URL(req.url, "http://x").pathname !== "/ws" || !req.headers["sec-websocket-key"]) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash("sha1")
      .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    const info = { state: null, playlist: null, caps: null, seen: 0 };
    clients.set(socket, info);
    log(`page connected (origin ${req.headers.origin || "?"}), ${clients.size} total`);
    // Current track, without a pop (it isn't a change).
    socket.write(encodeFrame(Buffer.from(JSON.stringify({ type: "nowplaying", ...nowPlaying, changed: false }), "utf8")));
    startNowPlaying();

    let buf = Buffer.alloc(0);
    socket.on("data", chunk => {
      buf = Buffer.concat([buf, chunk]);
      let frame;
      while ((frame = readFrame(buf))) {
        buf = buf.subarray(frame.length);
        if (frame.opcode === 0x8) { socket.end(encodeFrame(Buffer.alloc(0), 0x8)); return; }
        if (frame.opcode === 0x9) { socket.write(encodeFrame(frame.payload, 0xA)); continue; }
        if (frame.opcode === 0x1) {
          try {
            const msg = JSON.parse(frame.payload.toString("utf8"));
            if (msg.type === "state") {
              info.state = { ...msg.state, at: new Date().toISOString() }; info.seen = Date.now();
              // Page left visualizer mode (a slideshow command, a reload): stop capturing.
              // The grace period covers state reports already in flight when it started.
              if (msg.state.mode !== "visualizer" && audioProc && Date.now() - audioStartedAt > 5000) stopAudio();
              // Page is visualizing but nothing captures audio (the bridge restarted): start it.
              if (msg.state.mode === "visualizer" && !audioProc) startAudio();
              haUpdate();
            }
            if (msg.type === "playlist" && Array.isArray(msg.items)) { info.playlist = msg.items; haUpdate(); }
            if (msg.type === "caps") info.caps = msg.caps;
            if (msg.type === "presets" && Array.isArray(msg.names)) { info.presets = msg.names; haUpdate(); }
          } catch { /* ignore junk */ }
        }
      }
    });
    const drop = () => {
      if (clients.delete(socket)) log(`page disconnected, ${clients.size} left`);
      if (!clients.size) { stopAudio(); stopNowPlaying(); }
      haUpdate();
    };
    socket.on("close", drop);
    socket.on("error", drop);
  });

  // Keep idle connections alive and notice dead ones.
  setInterval(() => {
    for (const s of clients.keys()) s.write(encodeFrame(Buffer.alloc(0), 0x9));
  }, 30000).unref();

  server.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT} (ws path /ws)`));
}

function validate(cmd) {
  if (!cmd || typeof cmd !== "object") return "body must be a JSON object";
  if (!ACTIONS.has(cmd.action)) return `unknown action; use one of: ${[...ACTIONS].join(", ")}`;
  if (cmd.action === "show" && !/^(https?:|data:)/i.test(String(cmd.url || ""))) return "show needs an http(s) url";
  if (cmd.action === "goto" && !Number.isInteger(cmd.index)) return "goto needs an integer index";
  if (cmd.action === "pick" && !Number.isInteger(cmd.index) && !String(cmd.name || "").trim())
    return "pick needs a name or an integer index";
  if (cmd.action === "night" && !["on", "off", "auto"].includes(cmd.mode)) return "night mode must be on, off or auto";
  if (cmd.action === "titles" && !TITLE_MODES.includes(cmd.mode)) return `titles must be one of: ${TITLE_MODES.join(", ")}`;
  if (cmd.action === "visualizer") {
    cmd.mode = cmd.mode || "on";
    if (!VIZ_MODES.includes(cmd.mode)) return `visualizer mode must be one of: ${VIZ_MODES.join(", ")}`;
    if (cmd.mode === "res" && !(cmd.value >= 128 && cmd.value <= 1024)) return "visualizer res needs a size from 128 to 1024";
    if (cmd.mode === "fps" && !(cmd.value >= 5 && cmd.value <= 60)) return "visualizer fps needs a rate from 5 to 60";
    if (cmd.mode === "cycle" && !(cmd.value >= 0 && cmd.value <= 3600)) return "visualizer cycle needs seconds from 0 (off) to 3600";
    if (cmd.mode === "blend" && !(cmd.value >= 0 && cmd.value <= 10)) return "visualizer blend needs seconds from 0 to 10";
    if (cmd.mode === "pack" && !VIZ_PACKS.includes(cmd.value)) return `visualizer pack must be one of: ${VIZ_PACKS.join(", ")}`;
    if (cmd.mode === "order" && !["random", "sequential"].includes(cmd.value)) return "visualizer order must be random or sequential";
    if (cmd.mode === "ontrack" && !["on", "off"].includes(cmd.value)) return "visualizer ontrack must be on or off";
    if (cmd.mode === "fav" && !["on", "off", "toggle"].includes(cmd.value || "toggle")) return "visualizer fav must be on, off or toggle";
  }
  return null;
}

// Match by index, then exact name (case-insensitive), then a unique substring.
function resolvePick(playlist, cmd) {
  if (!playlist) return { status: 503, error: "Kraken page has not reported its playlist yet" };
  if (Number.isInteger(cmd.index)) {
    const item = playlist[cmd.index];
    return item ? { item } : { status: 404, error: `no item at index ${cmd.index} (playlist has ${playlist.length})` };
  }
  const want = String(cmd.name).trim().toLowerCase();
  const exact = playlist.filter(p => p.name.toLowerCase() === want);
  if (exact.length) return { item: exact[0] };
  const partial = playlist.filter(p => p.name.toLowerCase().includes(want));
  if (partial.length === 1) return { item: partial[0] };
  if (partial.length > 1) return { status: 409, error: `"${cmd.name}" matches ${partial.length} items: ${partial.map(p => p.name).join(", ")}` };
  return { status: 404, error: `no playlist item named "${cmd.name}"` };
}

/* ------------------------------------------------------------ websocket */
// Minimal RFC 6455 framing: unfragmented frames, client->server masked.
function readFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const maskOff = off;
  if (masked) off += 4;
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskOff + (i % 4)];
  return { opcode, payload, length: off + len };
}

function encodeFrame(payload, opcode = 0x1) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

function broadcast(clients, obj) {
  const frame = encodeFrame(Buffer.from(JSON.stringify(obj), "utf8"));
  for (const s of clients.keys()) s.write(frame);
}

/* --------------------------------------------------------------- helpers */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}
