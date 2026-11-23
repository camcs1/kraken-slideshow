/*
 * Kraken picker card for Home Assistant.
 *
 * Shows the Kraken slideshow's playlist as a grid of thumbnails; tapping one
 * holds it on the LCD (through the bridge's "Pick item" text entity). The item
 * on screen is outlined, and "Back to slideshow" appears while one is held.
 *
 * Register as a dashboard resource (JavaScript module):
 *   https://camcs1.github.io/kraken-slideshow/ha/kraken-picker-card.js?v=1
 *
 *   type: custom:kraken-picker-card
 *   # all optional:
 *   title: Pick a picture
 *   columns: 4            # thumbnails per row
 *   max_height: 420px     # scrolls beyond this; "none" for no limit
 *   animate: current      # current | all | none  (GIFs on hover always play)
 *   playlist_entity: sensor.kraken_lcd_playlist
 *   pick_entity: text.kraken_lcd_pick
 *   mode_entity: sensor.kraken_lcd_mode
 *   slideshow_entity: button.kraken_lcd_slideshow
 */
const KPC_VERSION = "1.0.0";

const KPC_DEFAULTS = {
  title: "Pick a picture",
  columns: 4,
  max_height: "420px",
  animate: "current",
  playlist_entity: "sensor.kraken_lcd_playlist",
  pick_entity: "text.kraken_lcd_pick",
  mode_entity: "sensor.kraken_lcd_mode",
  slideshow_entity: "button.kraken_lcd_slideshow",
};

const KPC_STYLE = `
  :host { display: block; }
  ha-card { overflow: hidden; }
  .head { display: flex; align-items: center; gap: 8px; padding: 12px 16px 8px; }
  .head .title { flex: 1; min-width: 0; }
  .head .title b { display: block; font-size: 16px; font-weight: 500; }
  .head .title span { display: block; font-size: 12px; color: var(--secondary-text-color);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .back { border: 0; border-radius: 999px; padding: 6px 12px; cursor: pointer; font: inherit; font-size: 13px;
    background: var(--primary-color); color: var(--text-primary-color, #fff); white-space: nowrap; }
  .back[hidden] { display: none; }
  .grid { display: grid; gap: 8px; padding: 4px 12px 12px; overflow-y: auto; overscroll-behavior: contain; }
  .tile { position: relative; aspect-ratio: 1; border-radius: 50%; overflow: hidden; cursor: pointer;
    background: var(--secondary-background-color, #222); outline: 2px solid transparent; outline-offset: 2px;
    transition: transform .12s ease, outline-color .12s ease; -webkit-tap-highlight-color: transparent; }
  .tile:hover { transform: scale(1.04); }
  .tile:focus-visible { outline-color: var(--secondary-text-color); }
  .tile.current { outline-color: var(--primary-color); }
  .tile.sent { animation: kpc-pulse .5s ease; }
  @keyframes kpc-pulse { 50% { transform: scale(.9); } }
  .tile img, .tile canvas, .tile video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
  .tile canvas { display: none; }
  .tile.frozen canvas { display: block; }
  .tile.frozen img { visibility: hidden; }
  .tile .num { position: absolute; left: 50%; bottom: 6%; transform: translateX(-50%); font-size: 10px; line-height: 1;
    padding: 2px 5px; border-radius: 999px; background: rgba(0,0,0,.6); color: #fff; pointer-events: none; }
  .tile.broken::after { content: "?"; position: absolute; inset: 0; display: grid; place-items: center;
    font-size: 20px; color: var(--secondary-text-color); }
  .empty { padding: 0 16px 16px; color: var(--secondary-text-color); font-size: 14px; }
`;

class KrakenPickerCard extends HTMLElement {
  setConfig(config) {
    this._config = Object.assign({}, KPC_DEFAULTS, config || {});
    this._listKey = null;
    if (this.shadowRoot) this._build();
  }

  static getStubConfig() { return {}; }
  getCardSize() { return 6; }
  getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot) { this.attachShadow({ mode: "open" }); this._build(); }
    this._update();
  }

  _build() {
    const c = this._config;
    this.shadowRoot.innerHTML = `<style>${KPC_STYLE}</style>
      <ha-card>
        <div class="head">
          <div class="title"><b></b><span></span></div>
          <button class="back" hidden>Back to slideshow</button>
        </div>
        <div class="grid" role="list"></div>
      </ha-card>`;
    const $ = s => this.shadowRoot.querySelector(s);
    this._titleEl = $(".title b");
    this._subEl = $(".title span");
    this._backEl = $(".back");
    this._grid = $(".grid");
    this._titleEl.textContent = c.title || "";
    this._grid.style.gridTemplateColumns = `repeat(${Math.max(1, Number(c.columns) || 4)}, minmax(0, 1fr))`;
    if (c.max_height && c.max_height !== "none") this._grid.style.maxHeight = c.max_height;
    this._backEl.addEventListener("click", () => this._call("button", "press", c.slideshow_entity));
    this._listKey = null;
    this._current = undefined;
  }

  _update() {
    if (!this._hass || !this._grid) return;
    const c = this._config;
    const pl = this._hass.states[c.playlist_entity];
    const items = (pl && Array.isArray(pl.attributes.items)) ? pl.attributes.items : [];
    const key = items.map(i => i.src).join("\n");
    if (key !== this._listKey) { this._listKey = key; this._render(items); }

    const m = this._hass.states[c.mode_entity];
    const mode = m ? m.state : "unavailable";
    const idx = (m && Number.isInteger(m.attributes.index) && mode !== "visualizer") ? m.attributes.index : -1;
    this._backEl.hidden = mode !== "picked" && mode !== "remote";
    this._subEl.textContent =
      mode === "unavailable" || mode === "disconnected" ? "Kraken page not connected" :
      mode === "visualizer" ? "Visualizer is on" :
      idx >= 0 ? `${mode === "picked" ? "Holding" : "Showing"} #${idx + 1}${m.attributes.name ? ` · ${m.attributes.name}` : ""}` : "";
    if (idx !== this._current) {
      const prev = this._tiles && this._tiles[this._current];
      if (prev) { prev.classList.remove("current"); this._setLive(prev, false); }
      this._current = idx;
      const cur = this._tiles && this._tiles[idx];
      if (cur) { cur.classList.add("current"); if (c.animate === "current") this._setLive(cur, true); }
    }
  }

  _render(items) {
    const c = this._config;
    this._grid.textContent = "";
    this._tiles = [];
    this._current = undefined;
    if (!items.length) {
      const p = document.createElement("div");
      p.className = "empty";
      p.textContent = "No playlist yet. It appears once the Kraken page reports to the bridge.";
      this._grid.appendChild(p);
      return;
    }
    items.forEach((item, i) => {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.tabIndex = 0;
      tile.setAttribute("role", "listitem");
      tile.title = `#${i + 1} ${item.name || ""}`.trim();
      if (item.type === "video") {
        const v = document.createElement("video");
        v.muted = true; v.playsInline = true; v.preload = "metadata";
        v.src = item.src + (item.src.includes("#") ? "" : "#t=0.5");
        tile.appendChild(v);
        tile._video = v;
      } else {
        const img = document.createElement("img");
        img.loading = "lazy"; img.decoding = "async"; img.alt = item.name || "";
        img.referrerPolicy = "no-referrer";
        const cv = document.createElement("canvas");
        img.addEventListener("load", () => {
          // Freeze animated images on a canvas so 50+ GIFs don't all play at once.
          if (c.animate === "all") return;
          try {
            const s = 160; cv.width = s; cv.height = s;
            const w = img.naturalWidth, h = img.naturalHeight, k = Math.max(s / w, s / h);
            cv.getContext("2d").drawImage(img, (s - w * k) / 2, (s - h * k) / 2, w * k, h * k);
            tile._frozenReady = true;
            if (!tile._live) tile.classList.add("frozen");
          } catch (e) { /* leave it animating */ }
        }, { once: true });
        img.addEventListener("error", () => tile.classList.add("broken"), { once: true });
        img.src = item.src;
        tile.append(img, cv);
      }
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = i + 1;
      tile.appendChild(num);
      tile.addEventListener("mouseenter", () => this._setLive(tile, true));
      tile.addEventListener("mouseleave", () => { if (!(c.animate === "current" && i === this._current)) this._setLive(tile, false); });
      const pick = () => this._pick(i, tile);
      tile.addEventListener("click", pick);
      tile.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
      this._grid.appendChild(tile);
      this._tiles.push(tile);
    });
  }

  _setLive(tile, on) {
    tile._live = on;
    if (tile._video) { if (on) tile._video.play().catch(() => {}); else tile._video.pause(); return; }
    if (on) tile.classList.remove("frozen");
    else if (tile._frozenReady) tile.classList.add("frozen");
  }

  _pick(i, tile) {
    tile.classList.remove("sent"); void tile.offsetWidth; tile.classList.add("sent");
    this._call("text", "set_value", this._config.pick_entity, { value: String(i + 1) });
  }

  _call(domain, service, entity_id, data) {
    if (!this._hass || !entity_id) return;
    this._hass.callService(domain, service, Object.assign({ entity_id }, data || {}));
  }
}

if (!customElements.get("kraken-picker-card")) {
  customElements.define("kraken-picker-card", KrakenPickerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "kraken-picker-card",
    name: "Kraken picker",
    description: "Thumbnail grid of the Kraken LCD slideshow; tap one to show it.",
    preview: false,
  });
  console.info(`%c KRAKEN-PICKER-CARD %c ${KPC_VERSION} `, "background:#7b2ff7;color:#fff", "");
}
