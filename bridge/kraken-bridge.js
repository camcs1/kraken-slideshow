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
 *                   node kraken-bridge.js status
 *                   node kraken-bridge.js playlist [names]
 *
 * Words after the action are joined with spaces, so HASS.Agent can append an
 * MQTT action payload like "pick Doorbell Cam" to the command "... send".
 */
"use strict";

const http = require("http");
const crypto = require("crypto");

const HOST = process.env.KRAKEN_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.KRAKEN_BRIDGE_PORT || 27880);
const ACTIONS = new Set(["next", "prev", "pause", "resume", "slideshow", "pick", "hold", "show", "goto", "night", "reload"]);

/* ------------------------------------------------------------------ CLI */
if (["send", "status", "playlist"].includes(process.argv[2])) {
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
    return { lastState: best ? best.state : null, playlist: best ? best.playlist : null };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || HOST}`);
    const { lastState, playlist } = primary();
    try {
      if (url.pathname === "/status") {
        return json(res, 200, { clients: clients.size, state: lastState });
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

      const problem = validate(cmd);
      if (problem) return json(res, 400, { error: problem });
      if (!clients.size) return json(res, 503, { error: "Kraken page is not connected" });

      // "hold" = pick whatever the page last reported it was showing.
      if (cmd.action === "hold") {
        if (!lastState || !Number.isInteger(lastState.index)) return json(res, 503, { error: "Kraken page has not reported what it is showing yet" });
        cmd = { action: "pick", index: lastState.index };
      }
      if (cmd.action === "pick") {
        const hit = resolvePick(playlist, cmd);
        if (hit.error) return json(res, hit.status, { error: hit.error, names: playlist ? playlist.map(p => p.name) : undefined });
        cmd = { action: "pick", index: hit.item.index, name: hit.item.name };
      }

      broadcast(clients, cmd);
      log(`-> ${JSON.stringify(cmd)} (${clients.size} client${clients.size === 1 ? "" : "s"})`);
      json(res, 200, { ok: true, sent: cmd, clients: clients.size });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  });

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
    const info = { state: null, playlist: null, seen: 0 };
    clients.set(socket, info);
    log(`page connected (origin ${req.headers.origin || "?"}), ${clients.size} total`);

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
            if (msg.type === "state") { info.state = { ...msg.state, at: new Date().toISOString() }; info.seen = Date.now(); }
            if (msg.type === "playlist" && Array.isArray(msg.items)) info.playlist = msg.items;
          } catch { /* ignore junk */ }
        }
      }
    });
    const drop = () => {
      if (clients.delete(socket)) log(`page disconnected, ${clients.size} left`);
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
