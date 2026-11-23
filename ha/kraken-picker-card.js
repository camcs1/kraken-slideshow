/*
 * Kraken picker card for Home Assistant.
 *
 * Shows the Kraken slideshow's playlist as a grid of thumbnails; tapping one
 * holds it on the LCD (through the bridge's "Pick item" text entity). The item
 * on screen is outlined, and "Back to slideshow" appears while one is held.
 *
 * Register as a dashboard resource (JavaScript module):
 *   https://camcs1.github.io/kraken-slideshow/ha/kraken-picker-card.js?v=5
 *
 *   type: custom:kraken-picker-card
 *   # all optional:
 *   title: Pick a picture
 *   columns: 4            # thumbnails per row
 *   max_height: 420px     # scrolls beyond this; "none" for no limit
 *   animate: current      # current | all | none  (GIFs on hover always play)
 *   collapsed: false      # start folded; tapping the header toggles (remembered per browser)
 *   playlist_entity: sensor.kraken_lcd_playlist
 *   pick_entity: text.kraken_lcd_pick
 *   mode_entity: sensor.kraken_lcd_mode
 *   slideshow_entity: button.kraken_lcd_slideshow
 */
const KPC_VERSION = "1.4.0";

const KPC_DEFAULTS = {
  title: "Pick a picture",
  columns: 4,
  max_height: "420px",
  animate: "current",
  collapsed: false,
  playlist_entity: "sensor.kraken_lcd_playlist",
  pick_entity: "text.kraken_lcd_pick",
  mode_entity: "sensor.kraken_lcd_mode",
  slideshow_entity: "button.kraken_lcd_slideshow",
};

const KPC_STYLE = `
  :host { display: block; }
  ha-card { overflow: hidden; }
  .head { display: flex; align-items: center; gap: 8px; padding: 12px 16px 8px; cursor: pointer; user-select: none; }
  .collapsed .head { padding-bottom: 12px; }
  .collapsed .grid { display: none; }
  .chev { width: 24px; height: 24px; flex: none; fill: var(--secondary-text-color); transition: transform .2s ease; }
  .collapsed .chev { transform: rotate(-90deg); }
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
        <div class="head" role="button" tabindex="0" aria-expanded="true">
          <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M7.41 8.58 12 13.17l4.59-4.59L18 10l-6 6-6-6z"/></svg>
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
    this._backEl.addEventListener("click", e => { e.stopPropagation(); this._call("button", "press", c.slideshow_entity); });
    // Collapsible: click the header. The choice is remembered per browser.
    const head = $(".head");
    const toggle = () => this._setCollapsed(!this._collapsed, true);
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", e => { if (e.target === head && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(); } });
    let saved = null;
    try { saved = localStorage.getItem(this._storeKey()); } catch (e) { /* storage blocked */ }
    this._setCollapsed(saved !== null ? saved === "1" : !!c.collapsed, false);
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

  _storeKey() { return `kraken-picker-collapsed:${this._config.playlist_entity}`; }

  _setCollapsed(on, remember) {
    this._collapsed = on;
    const card = this.shadowRoot.querySelector("ha-card");
    card.classList.toggle("collapsed", on);
    this.shadowRoot.querySelector(".head").setAttribute("aria-expanded", String(!on));
    if (remember) { try { localStorage.setItem(this._storeKey(), on ? "1" : "0"); } catch (e) { /* ignore */ } }
    // Let the sections grid re-measure the card's height.
    this.dispatchEvent(new Event("iron-resize", { bubbles: true, composed: true }));
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

/*
 * Kraken screen card: the image on the LCD, drawn round like the pump screen.
 *
 *   type: custom:kraken-screen-card
 *   entity: image.kraken_lcd_now   # optional
 *   ring: true                     # thin ring around the circle
 *
 * Sized by the dashboard grid; the circle takes the largest square that fits.
 */
class KrakenScreenCard extends HTMLElement {
  setConfig(config) {
    // view_entity: carries the page's fit/background/zoom/rotation/offset (attribute "view")
    this._config = Object.assign({ entity: "image.kraken_lcd_now", view_entity: "sensor.kraken_lcd_mode", ring: true }, config || {});
    if (this.shadowRoot) this._applyConfig();
  }
  static getStubConfig() { return {}; }
  getCardSize() { return 3; }
  getGridOptions() { return { columns: 6, rows: 2, min_rows: 2 }; }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this.shadowRoot.innerHTML = `<style>
          :host { display: block; height: 100%; }
          ha-card { height: 100%; min-height: 112px; box-sizing: border-box; display: grid; place-items: center;
            background: none; border: none; box-shadow: none; cursor: pointer; container-type: size; }
          .screen { width: min(100cqw, 100cqh); aspect-ratio: 1; border-radius: 50%; overflow: hidden; position: relative;
            background: #000; box-sizing: border-box; }
          .screen.ring { box-shadow: 0 0 0 2px var(--divider-color, #444), 0 4px 14px rgba(0,0,0,.45); }
          img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block;
            transform-origin: 50% 50%;
            transform: translate(var(--tx, 0%), var(--ty, 0%)) scale(var(--scale, 1)) rotate(var(--rot, 0deg)); }
          img[hidden] { display: none; }
        </style>
        <ha-card><div class="screen"><img alt="Kraken screen"></div></ha-card>`;
      this._img = this.shadowRoot.querySelector("img");
      this._screen = this.shadowRoot.querySelector(".screen");
      this._img.addEventListener("error", () => { this._img.hidden = true; });
      this.shadowRoot.querySelector("ha-card").addEventListener("click", () => {
        this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: this._config.entity } }));
      });
      this._applyConfig();
    }
    const st = hass.states[this._config.entity];
    const pic = st && st.state !== "unavailable" ? st.attributes.entity_picture : null;
    if (pic !== this._pic) {
      this._pic = pic;
      if (pic) { this._img.hidden = false; this._img.src = hass.hassUrl ? hass.hassUrl(pic) : pic; }
      else { this._img.hidden = true; this._img.removeAttribute("src"); }
    }
    // Mirror the Kraken page's own display settings (same CSS transform it uses).
    const vs = hass.states[this._config.view_entity];
    const v = (vs && vs.attributes.view) || null;
    const key = JSON.stringify(v);
    if (key !== this._viewKey) {
      this._viewKey = key;
      const s = this._img.style;
      s.objectFit = v && v.fit === "cover" ? "cover" : "contain";
      s.setProperty("--scale", v ? String(v.scale || 1) : "1");
      s.setProperty("--rot", `${v ? v.rotDeg || 0 : 0}deg`);
      s.setProperty("--tx", `${v ? v.txPct || 0 : 0}%`);
      s.setProperty("--ty", `${v ? v.tyPct || 0 : 0}%`);
      this._screen.style.background = (v && v.bg) || "#000";
    }
  }

  _applyConfig() { if (this._screen) this._screen.classList.toggle("ring", !!this._config.ring); }
}

/*
 * Kraken visualizer card: MilkDrop controls for the Kraken LCD.
 *
 *   type: custom:kraken-visualizer-card
 *   # all optional:
 *   title: Visualizer
 *   max_height: 320px            # preset list scrolls beyond this ("none" lists every row)
 *   settings_collapsed: true     # settings start folded (tapping the header toggles; remembered per browser)
 *   cycle_presets: [0, 15, 30, 60, 120]
 *   visualizer_entity, preset_entity, next_entity, random_entity, title_entity, pack_entity,
 *   cycle_entity, order_entity, blend_entity, ontrack_entity, fav_entity, mode_entity,
 *   track_entity, titles_entity   # see KVC_DEFAULTS
 *
 * Header: on/off, the preset on screen, favourite star, Next / Random / Title.
 * Browser: pack chooser, search, and the pack's presets (from the preset select's
 * options); tap one to load it. Only the visible rows are drawn, so a 552-name
 * pack scrolls as fast as a short one. Settings: auto-change, order, blend,
 * new preset per track, track titles.
 */
const KVC_DEFAULTS = {
  title: "Visualizer",
  max_height: "320px",
  settings_collapsed: true,
  cycle_presets: [0, 15, 30, 60, 120],
  visualizer_entity: "switch.kraken_lcd_visualizer",
  preset_entity: "select.kraken_lcd_preset",
  next_entity: "button.kraken_lcd_viz_next",
  random_entity: "button.kraken_lcd_viz_random",
  title_entity: "button.kraken_lcd_title_show",
  pack_entity: "select.kraken_lcd_viz_pack",
  cycle_entity: "number.kraken_lcd_viz_cycle",
  order_entity: "select.kraken_lcd_viz_order",
  blend_entity: "number.kraken_lcd_viz_blend",
  ontrack_entity: "switch.kraken_lcd_viz_ontrack",
  fav_entity: "switch.kraken_lcd_viz_fav",
  mode_entity: "sensor.kraken_lcd_mode",
  track_entity: "sensor.kraken_lcd_track",
  titles_entity: "select.kraken_lcd_titles",
};
const KVC_NO_PRESET = "—";
const KVC_ROW = 40;          // px per preset row (the list is virtualised on this)
const KVC_ICON = {
  power: "M16.56,5.44L15.11,6.89C16.84,7.94 18,9.83 18,12A6,6 0 0,1 12,18A6,6 0 0,1 6,12C6,9.83 7.16,7.94 8.88,6.88L7.44,5.44C5.36,6.88 4,9.28 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12C20,9.28 18.64,6.88 16.56,5.44M13,3H11V13H13",
  next: "M16,18H18V6H16M6,18L14.5,12L6,6V18Z",
  shuffle: "M17,3L22.25,7.5L17,12L22.25,16.5L17,21V18H14.26L11.44,15.18L13.56,13.06L15.5,15H17V12L17,9H15.5L6.5,18H2V15H5.26L14.26,6H17V3M2,6H6.5L9.32,8.82L7.2,10.94L5.26,9H2V6Z",
  title: "M5,4V7H10.5V19H13.5V7H19V4H5Z",
  star: "M12,17.27L18.18,21L16.54,13.97L22,9.24L14.81,8.62L12,2L9.19,8.62L2,9.24L7.45,13.97L5.82,21L12,17.27Z",
  starOff: "M12,15.39L8.24,17.66L9.23,13.38L5.91,10.5L10.29,10.13L12,6.09L13.71,10.13L18.09,10.5L14.77,13.38L15.76,17.66M22,9.24L14.81,8.62L12,2L9.19,8.62L2,9.24L7.45,13.97L5.82,21L12,17.27L18.18,21L16.54,13.97L22,9.24Z",
  search: "M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z",
  close: "M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z",
  locate: "M11,2V4.07C7.38,4.53 4.53,7.38 4.07,11H2V13H4.07C4.53,16.62 7.38,19.47 11,19.93V22H13V19.93C16.62,19.47 19.47,16.62 19.93,13H22V11H19.93C19.47,7.38 16.62,4.53 13,4.07V2M11,6.08V8H13V6.08C15.5,6.5 17.5,8.5 17.92,11H16V13H17.92C17.5,15.5 15.5,17.5 13,17.92V16H11V17.92C8.5,17.5 6.5,15.5 6.08,13H8V11H6.08C6.5,8.5 8.5,6.5 11,6.08M12,11A1,1 0 0,0 11,12A1,1 0 0,0 12,13A1,1 0 0,0 13,12A1,1 0 0,0 12,11Z",
  note: "M12 3V13.55C11.41 13.21 10.73 13 10 13C7.79 13 6 14.79 6 17S7.79 21 10 21 14 19.21 14 17V7H18V3H12Z",
  chev: "M7.41 8.58 12 13.17l4.59-4.59L18 10l-6 6-6-6z",
};
const kvcSvg = (d, cls) => `<svg class="${cls || "ic"}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const kvcBad = s => !s || s.state === "unavailable" || s.state === "unknown";
const kvcGone = s => !s || s.state === "unavailable";   // buttons sit at "unknown" until first pressed

const KVC_STYLE = `
  :host { display: block; container-type: inline-size; }
  ha-card { overflow: hidden; color: var(--primary-text-color); }
  button { font: inherit; color: inherit; -webkit-tap-highlight-color: transparent; }
  button:disabled, select:disabled, input:disabled { opacity: .4; cursor: default; }
  .ic { width: 20px; height: 20px; fill: currentColor; flex: none; }
  .top { display: flex; align-items: center; gap: 12px; padding: 14px 16px 8px; }
  .power { width: 44px; height: 44px; flex: none; border-radius: 50%; border: 0; cursor: pointer; display: grid; place-items: center;
    background: var(--secondary-background-color, #333); color: var(--secondary-text-color); transition: background .15s, color .15s; }
  .power .ic { width: 24px; height: 24px; }
  .power[aria-checked="true"] { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .now { flex: 1; min-width: 0; }
  .now > * { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .now .label { font-size: 12px; color: var(--secondary-text-color); }
  .now .preset { font-size: 16px; font-weight: 500; line-height: 1.3; }
  .now .preset.off { color: var(--secondary-text-color); }
  .now .track { font-size: 12px; color: var(--secondary-text-color); display: flex; align-items: center; gap: 4px; }
  .now .track .ic { width: 14px; height: 14px; }
  .now .track[hidden] { display: none; }
  .iconbtn { width: 40px; height: 40px; flex: none; border: 0; border-radius: 50%; background: none; cursor: pointer;
    display: grid; place-items: center; color: var(--secondary-text-color); }
  .iconbtn:not(:disabled):hover { background: var(--secondary-background-color, rgba(127,127,127,.15)); }
  .iconbtn[aria-pressed="true"] { color: var(--kvc-star, #fdd835); }
  .iconbtn.small { width: 36px; height: 36px; }
  .actions { display: flex; gap: 8px; padding: 0 16px 12px; }
  .act { flex: 1 1 0; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 6px; height: 36px;
    border: 1px solid var(--divider-color, rgba(127,127,127,.3)); border-radius: 18px; background: none; cursor: pointer; font-size: 13px; }
  .act span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .act:not(:disabled):active { background: var(--secondary-background-color); }
  .browser { border-top: 1px solid var(--divider-color, rgba(127,127,127,.2)); padding: 12px 12px 8px; }
  .tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .field { height: 36px; box-sizing: border-box; border-radius: 8px; border: 1px solid var(--divider-color, rgba(127,127,127,.3));
    background: var(--input-fill-color, var(--secondary-background-color, transparent)); color: var(--primary-text-color); font: inherit; font-size: 14px; }
  select.field { flex: 1 1 110px; min-width: 0; padding: 0 8px; }
  .search { flex: 3 1 140px; min-width: 0; display: flex; align-items: center; gap: 4px; padding: 0 4px 0 8px; }
  .search .ic { color: var(--secondary-text-color); width: 18px; height: 18px; }
  .search input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; color: inherit; font: inherit; height: 100%; }
  .search input::-webkit-search-cancel-button { display: none; }
  .search .clear { width: 28px; height: 28px; border: 0; background: none; cursor: pointer; display: grid; place-items: center; color: var(--secondary-text-color); }
  .search .clear[hidden] { display: none; }
  .toolbtns { display: flex; gap: 0; margin-left: auto; }
  .count { font-size: 12px; color: var(--secondary-text-color); padding: 6px 4px 4px; }
  .list { position: relative; overflow-y: auto; overscroll-behavior: contain; border-radius: 8px; }
  .spacer { position: relative; }
  .row { position: absolute; left: 0; right: 0; height: ${KVC_ROW}px; box-sizing: border-box; display: flex; align-items: center; gap: 8px;
    padding: 0 10px 0 12px; cursor: pointer; border-radius: 8px; font-size: 14px; border-left: 3px solid transparent; }
  .row:hover { background: var(--secondary-background-color, rgba(127,127,127,.12)); }
  .row:focus-visible { outline: 2px solid var(--primary-color); outline-offset: -2px; }
  .row .nm { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row .ic { width: 16px; height: 16px; color: var(--kvc-star, #fdd835); }
  .row.current { background: color-mix(in srgb, var(--primary-color) 18%, transparent); border-left-color: var(--primary-color); font-weight: 500; }
  .row.pending { border-left-color: var(--primary-color); animation: kvc-blink 1s ease infinite; }
  @keyframes kvc-blink { 50% { opacity: .55; } }
  .empty { padding: 12px 4px 16px; color: var(--secondary-text-color); font-size: 14px; }
  .empty[hidden] { display: none; }
  .set { border-top: 1px solid var(--divider-color, rgba(127,127,127,.2)); }
  .sethead { display: flex; align-items: center; gap: 8px; padding: 12px 16px; cursor: pointer; user-select: none; }
  .sethead b { font-weight: 500; font-size: 14px; }
  .sethead .sum { flex: 1; min-width: 0; font-size: 12px; color: var(--secondary-text-color); text-align: right;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chev { width: 22px; height: 22px; flex: none; fill: var(--secondary-text-color); transition: transform .2s ease; }
  .set.collapsed .chev { transform: rotate(-90deg); }
  .set.collapsed .setbody { display: none; }
  .setbody { padding: 0 16px 14px; display: grid; gap: 12px; }
  .srow { display: grid; grid-template-columns: minmax(96px, 150px) 1fr; gap: 6px 12px; align-items: center; }
  .srow > .lbl { font-size: 14px; }
  .srow > .lbl small { display: block; font-size: 11px; color: var(--secondary-text-color); }
  .ctl { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
  .chip { height: 30px; padding: 0 12px; border-radius: 15px; cursor: pointer; font-size: 13px; background: none;
    border: 1px solid var(--divider-color, rgba(127,127,127,.3)); }
  .chip[aria-pressed="true"] { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
  .num { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--secondary-text-color); }
  .num input { width: 64px; height: 30px; padding: 0 6px; }
  .seg { display: inline-flex; border: 1px solid var(--divider-color, rgba(127,127,127,.3)); border-radius: 15px; overflow: hidden; max-width: 100%; }
  .seg button { height: 30px; padding: 0 12px; border: 0; background: none; cursor: pointer; font-size: 13px; white-space: nowrap; }
  .seg button + button { border-left: 1px solid var(--divider-color, rgba(127,127,127,.3)); }
  .seg button[aria-pressed="true"] { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .slider { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; }
  .slider input { flex: 1; min-width: 80px; accent-color: var(--primary-color); }
  .slider span { font-size: 13px; min-width: 36px; text-align: right; font-variant-numeric: tabular-nums; }
  .tgl { width: 40px; height: 22px; border-radius: 11px; border: 0; padding: 0; position: relative; cursor: pointer;
    background: var(--disabled-color, rgba(127,127,127,.45)); transition: background .15s; }
  .tgl::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .15s; }
  .tgl[aria-checked="true"] { background: var(--primary-color); }
  .tgl[aria-checked="true"]::after { transform: translateX(18px); }
  @container (max-width: 440px) { .srow { grid-template-columns: 1fr; gap: 6px; } .tools { gap: 6px; } }
`;

class KrakenVisualizerCard extends HTMLElement {
  setConfig(config) {
    const c = Object.assign({}, KVC_DEFAULTS, config || {});
    if (!Array.isArray(c.cycle_presets)) c.cycle_presets = KVC_DEFAULTS.cycle_presets;
    this._config = c;
    if (this.shadowRoot) { this._build(); this._update(); }
  }

  static getStubConfig() { return {}; }
  getCardSize() { return 9; }
  getGridOptions() { return { columns: 12, rows: "auto", min_columns: 6 }; }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot) { this.attachShadow({ mode: "open" }); this._build(); }
    this._update();
  }

  _build() {
    const c = this._config, I = KVC_ICON;
    this.shadowRoot.innerHTML = `<style>${KVC_STYLE}</style>
      <ha-card>
        <div class="top">
          <button class="power" role="switch" aria-checked="false" title="Visualizer on/off">${kvcSvg(I.power)}</button>
          <div class="now">
            <span class="label"></span>
            <b class="preset"></b>
            <span class="track" hidden>${kvcSvg(I.note)}<span></span></span>
          </div>
          <button class="iconbtn star" aria-pressed="false" title="Favourite">${kvcSvg(I.starOff)}</button>
        </div>
        <div class="actions">
          <button class="act" data-act="next" title="Next preset">${kvcSvg(I.next)}<span>Next</span></button>
          <button class="act" data-act="random" title="Random preset">${kvcSvg(I.shuffle)}<span>Random</span></button>
          <button class="act" data-act="title" title="Show the track title">${kvcSvg(I.title)}<span>Title</span></button>
        </div>
        <div class="browser">
          <div class="tools">
            <select class="field pack" aria-label="Preset pack"></select>
            <label class="field search">${kvcSvg(I.search)}<input type="search" placeholder="Search presets" aria-label="Search presets" autocomplete="off" spellcheck="false"><button class="clear" hidden title="Clear">${kvcSvg(I.close)}</button></label>
            <div class="toolbtns">
              <button class="iconbtn small favonly" aria-pressed="false" title="Favourites only">${kvcSvg(I.star)}</button>
              <button class="iconbtn small locate" title="Scroll to the preset on screen">${kvcSvg(I.locate)}</button>
            </div>
          </div>
          <div class="count"></div>
          <div class="list" role="listbox" aria-label="Presets"><div class="spacer"></div></div>
          <div class="empty" hidden></div>
        </div>
        <div class="set">
          <div class="sethead" role="button" tabindex="0" aria-expanded="true">
            <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="${I.chev}"/></svg><b>Settings</b><span class="sum"></span>
          </div>
          <div class="setbody">
            <div class="srow"><span class="lbl">Auto-change<small>new preset every</small></span>
              <div class="ctl cycle"><span class="chips"></span><label class="num"><input class="field cyclenum" type="number" inputmode="numeric" aria-label="Seconds">s</label></div></div>
            <div class="srow"><span class="lbl">Order</span><div class="ctl"><div class="seg order"></div></div></div>
            <div class="srow"><span class="lbl">Blend</span><div class="ctl slider"><input class="blend" type="range" aria-label="Blend seconds"><span class="blendval"></span></div></div>
            <div class="srow"><span class="lbl">New preset per track</span><div class="ctl"><button class="tgl ontrack" role="switch" aria-checked="false" aria-label="New preset per track"></button></div></div>
            <div class="srow"><span class="lbl">Track titles</span><div class="ctl"><div class="seg titles"></div></div></div>
          </div>
        </div>
      </ha-card>`;
    const $ = s => this.shadowRoot.querySelector(s);
    this._el = {
      power: $(".power"), label: $(".now .label"), preset: $(".now .preset"), track: $(".now .track"), trackText: $(".now .track span"),
      star: $(".star"), pack: $(".pack"), search: $(".search input"), clear: $(".search .clear"), favonly: $(".favonly"),
      locate: $(".locate"), count: $(".count"), list: $(".list"), spacer: $(".spacer"), empty: $(".empty"),
      set: $(".set"), sethead: $(".sethead"), sum: $(".sethead .sum"), chips: $(".cycle .chips"), cyclenum: $(".cyclenum"),
      order: $(".seg.order"), blend: $(".blend"), blendval: $(".blendval"), ontrack: $(".ontrack"), titles: $(".seg.titles"),
      acts: [...this.shadowRoot.querySelectorAll(".act")],
    };
    const e = this._el;
    this._query = ""; this._favOnly = false; this._names = []; this._namesKey = null; this._filtered = [];
    this._favSet = new Set(); this._cur = ""; this._pending = null; this._range = null; this._optKeys = {};
    if (c.max_height && c.max_height !== "none") e.list.style.maxHeight = c.max_height;
    this._virtual = !!(c.max_height && c.max_height !== "none");

    e.power.addEventListener("click", () => {
      const on = e.power.getAttribute("aria-checked") === "true";
      this._call("switch", on ? "turn_off" : "turn_on", c.visualizer_entity);
    });
    e.star.addEventListener("click", () => {
      const on = e.star.getAttribute("aria-pressed") === "true";
      this._call("switch", on ? "turn_off" : "turn_on", c.fav_entity);
    });
    const actEnt = { next: c.next_entity, random: c.random_entity, title: c.title_entity };
    e.acts.forEach(b => b.addEventListener("click", () => this._call("button", "press", actEnt[b.dataset.act])));
    e.pack.addEventListener("change", () => { if (e.pack.value) this._call("select", "select_option", c.pack_entity, { option: e.pack.value }); });
    e.search.addEventListener("input", () => { this._query = e.search.value; e.clear.hidden = !this._query; this._refilter(true); });
    e.clear.addEventListener("click", ev => { ev.preventDefault(); e.search.value = ""; this._query = ""; e.clear.hidden = true; this._refilter(true); e.search.focus(); });
    e.favonly.addEventListener("click", () => { this._favOnly = !this._favOnly; e.favonly.setAttribute("aria-pressed", String(this._favOnly)); this._refilter(true); });
    e.locate.addEventListener("click", () => this._scrollToCurrent(true));
    e.list.addEventListener("scroll", () => {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this._renderRows(false); });
    }, { passive: true });
    const pick = row => { if (row && row.dataset.name != null) this._pick(row.dataset.name); };
    e.list.addEventListener("click", ev => pick(ev.target.closest(".row")));
    e.list.addEventListener("keydown", ev => {
      const row = ev.target.closest(".row");
      if (!row) return;
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(row); }
      else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") { ev.preventDefault(); this._focusRow(Number(row.dataset.i) + (ev.key === "ArrowDown" ? 1 : -1)); }
    });

    // Settings
    e.cyclenum.addEventListener("change", () => this._setNumber(c.cycle_entity, e.cyclenum.value));
    e.cyclenum.addEventListener("keydown", ev => { if (ev.key === "Enter") e.cyclenum.blur(); });
    e.chips.addEventListener("click", ev => { const b = ev.target.closest(".chip"); if (b) this._setNumber(c.cycle_entity, b.dataset.v); });
    e.blend.addEventListener("input", () => { this._blendDrag = true; e.blendval.textContent = `${Number(e.blend.value)} s`; });
    e.blend.addEventListener("change", () => { this._blendDrag = false; this._setNumber(c.blend_entity, e.blend.value); });
    e.order.addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) this._call("select", "select_option", c.order_entity, { option: b.dataset.v }); });
    e.titles.addEventListener("click", ev => { const b = ev.target.closest("button"); if (b) this._call("select", "select_option", c.titles_entity, { option: b.dataset.v }); });
    e.ontrack.addEventListener("click", () => {
      const on = e.ontrack.getAttribute("aria-checked") === "true";
      this._call("switch", on ? "turn_off" : "turn_on", c.ontrack_entity);
    });
    const toggle = () => this._setCollapsed(!this._collapsed, true);
    e.sethead.addEventListener("click", toggle);
    e.sethead.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } });
    let saved = null;
    try { saved = localStorage.getItem(this._storeKey()); } catch (err) { /* storage blocked */ }
    this._setCollapsed(saved !== null ? saved === "1" : !!c.settings_collapsed, false);
  }

  _update() {
    if (!this._hass || !this._el) return;
    const c = this._config, e = this._el, S = this._hass.states;
    const vis = S[c.visualizer_entity], ps = S[c.preset_entity], mode = S[c.mode_entity], fav = S[c.fav_entity];
    const vizOn = !!vis && vis.state === "on";
    const connected = !!mode && !["unavailable", "unknown", "disconnected"].includes(mode.state);

    // Header
    e.power.disabled = kvcBad(vis);
    e.power.setAttribute("aria-checked", String(vizOn));
    const psState = ps && !kvcBad(ps) && ps.state !== KVC_NO_PRESET ? ps.state : "";
    const cur = (vizOn && mode && mode.state === "visualizer" && mode.attributes.name) || psState;
    this._cur = cur;
    if (this._pending && (this._pending.name === cur || Date.now() - this._pending.at > 8000)) this._pending = null;
    const packSt = S[c.pack_entity];
    e.label.textContent = !connected ? "Kraken page not connected"
      : `${c.title ? `${c.title} · ` : ""}${vizOn ? "On" : "Off"}${packSt && !kvcBad(packSt) ? ` · ${packSt.state}` : ""}`;
    e.preset.textContent = cur || (vizOn ? "Loading…" : "No preset");
    e.preset.classList.toggle("off", !vizOn);
    e.preset.title = cur;
    const tr = S[c.track_entity];
    const track = tr && !kvcBad(tr) ? String(tr.state || "") : "";
    e.track.hidden = !track;
    e.trackText.textContent = track ? `Now playing: ${track}` : "";
    e.track.title = track;
    const favOn = !!fav && fav.state === "on";
    e.star.disabled = kvcBad(fav) || !vizOn || !cur;
    e.star.setAttribute("aria-pressed", String(favOn));
    e.star.querySelector("path").setAttribute("d", favOn ? KVC_ICON.star : KVC_ICON.starOff);
    const favCount = fav && Number.isFinite(Number(fav.attributes.favourites)) ? Number(fav.attributes.favourites) : null;
    e.star.title = `${favOn ? "Remove from favourites" : "Add to favourites"}${favCount !== null ? ` (${favCount} saved)` : ""}`;
    const actEnt = { next: c.next_entity, random: c.random_entity, title: c.title_entity };
    e.acts.forEach(b => { b.disabled = kvcGone(S[actEnt[b.dataset.act]]); });

    // Pack chooser
    this._fillOptions(e.pack, packSt, "pack", null);
    if (document.activeElement !== this || this.shadowRoot.activeElement !== e.pack) {
      if (packSt && !kvcBad(packSt)) e.pack.value = packSt.state;
    }

    // Preset list
    const names = ps && !kvcBad(ps) && Array.isArray(ps.attributes.options) ? ps.attributes.options.filter(n => n !== KVC_NO_PRESET) : [];
    const favNames = fav && Array.isArray(fav.attributes.names) ? fav.attributes.names : [];
    const favKey = favNames.join("\n");
    const favChanged = favKey !== this._favKey;
    if (favChanged) { this._favKey = favKey; this._favSet = new Set(favNames); }
    e.favonly.hidden = !favNames.length && !this._favOnly;
    const key = names.join("\n");
    const listChanged = key !== this._namesKey;
    if (listChanged) { this._namesKey = key; this._names = names; }
    if (listChanged || (favChanged && this._favOnly)) this._refilter(listChanged);
    else this._renderRows(cur !== this._drawnCur || favChanged || this._pendingDrawn !== (this._pending && this._pending.name));
    if (listChanged && cur) requestAnimationFrame(() => this._scrollToCurrent(false));
    e.locate.disabled = !cur || !this._filtered.includes(cur);
    this._why = !connected ? "The Kraken page isn't connected, so there are no presets to show."
      : kvcBad(ps) ? "Preset list unavailable." : "No presets yet. They appear once the visualizer loads a pack.";
    this._showEmpty();
    e.search.disabled = !names.length;

    // Settings
    const cyc = S[c.cycle_entity];
    const cycOk = !kvcBad(cyc);
    const cycVal = cycOk ? Number(cyc.state) : NaN;
    const chipKey = c.cycle_presets.join(",");
    if (this._chipKey !== chipKey) {
      this._chipKey = chipKey;
      e.chips.textContent = "";
      e.chips.style.display = "contents";
      for (const v of c.cycle_presets) {
        const b = document.createElement("button");
        b.className = "chip"; b.dataset.v = String(v); b.textContent = this._secs(Number(v));
        e.chips.appendChild(b);
      }
    }
    for (const b of e.chips.children) { b.disabled = !cycOk; b.setAttribute("aria-pressed", String(cycOk && Number(b.dataset.v) === cycVal)); }
    e.cyclenum.disabled = !cycOk;
    if (cycOk) {
      e.cyclenum.min = cyc.attributes.min ?? 0; e.cyclenum.max = cyc.attributes.max ?? 600; e.cyclenum.step = cyc.attributes.step ?? 5;
    }
    if (this.shadowRoot.activeElement !== e.cyclenum) e.cyclenum.value = cycOk && Number.isFinite(cycVal) ? String(cycVal) : "";

    const ord = S[c.order_entity];
    this._fillSeg(e.order, ord, ["random", "sequential"], { random: "Random", sequential: "In order" });
    const ttl = S[c.titles_entity];
    this._fillSeg(e.titles, ttl, ["visualizer", "always", "off"], { visualizer: "With visualizer", always: "Always", off: "Off" });

    const bl = S[c.blend_entity];
    const blOk = !kvcBad(bl);
    e.blend.disabled = !blOk;
    if (blOk) { e.blend.min = bl.attributes.min ?? 0; e.blend.max = bl.attributes.max ?? 10; e.blend.step = bl.attributes.step ?? 0.5; }
    if (!this._blendDrag) {
      const bv = blOk ? Number(bl.state) : NaN;
      if (Number.isFinite(bv)) e.blend.value = String(bv);
      e.blendval.textContent = Number.isFinite(bv) ? `${bv} s` : "–";
    }
    const ot = S[c.ontrack_entity];
    e.ontrack.disabled = kvcBad(ot);
    e.ontrack.setAttribute("aria-checked", String(!!ot && ot.state === "on"));

    const sum = [];
    if (cycOk && Number.isFinite(cycVal)) sum.push(cycVal > 0 ? `every ${this._secs(cycVal)}` : "auto-change off");
    if (!kvcBad(ord)) sum.push(ord.state);
    if (blOk) sum.push(`blend ${Number(bl.state)} s`);
    if (ot && ot.state === "on") sum.push("per track");
    e.sum.textContent = sum.join(" · ");
  }

  _secs(v) { return !v ? "Off" : v % 60 === 0 ? `${v / 60} min` : `${v} s`; }

  _fillOptions(sel, st, key) {
    const opts = st && !kvcBad(st) && Array.isArray(st.attributes.options) ? st.attributes.options : [];
    const k = opts.join("\n");
    sel.disabled = !opts.length;
    if (this._optKeys[key] === k) return;
    this._optKeys[key] = k;
    sel.textContent = "";
    for (const o of opts) { const op = document.createElement("option"); op.value = o; op.textContent = o; sel.appendChild(op); }
  }

  _fillSeg(seg, st, fallback, labels) {
    const ok = !kvcBad(st);
    const opts = ok && Array.isArray(st.attributes.options) && st.attributes.options.length ? st.attributes.options : fallback;
    const k = opts.join("\n");
    if (seg._k !== k) {
      seg._k = k;
      seg.textContent = "";
      for (const o of opts) {
        const b = document.createElement("button");
        b.dataset.v = o; b.textContent = labels[o] || (o.charAt(0).toUpperCase() + o.slice(1));
        seg.appendChild(b);
      }
    }
    for (const b of seg.children) { b.disabled = !ok; b.setAttribute("aria-pressed", String(ok && st.state === b.dataset.v)); }
  }

  // Rebuild the filtered list (search words must all match, any order, case-insensitive).
  _refilter(resetScroll) {
    const words = this._query.toLowerCase().split(/\s+/).filter(Boolean);
    let list = this._names;
    if (this._favOnly) list = list.filter(n => this._favSet.has(n));
    if (words.length) list = list.filter(n => { const l = n.toLowerCase(); return words.every(w => l.includes(w)); });
    this._filtered = list;
    const total = this._names.length;
    this._el.count.textContent = !total ? "" : list.length === total ? `${total} presets` : `${list.length} of ${total} presets`;
    this._el.spacer.style.height = `${list.length * KVC_ROW}px`;
    if (resetScroll) this._el.list.scrollTop = 0;
    this._renderRows(true);
    this._el.locate.disabled = !this._cur || !list.includes(this._cur);
    this._showEmpty();
  }

  _showEmpty() {
    const e = this._el;
    const msg = !this._names.length ? (this._why || "")
      : !this._filtered.length ? (this._favOnly && !this._query ? "No favourites in this pack." : "No presets match.") : "";
    e.empty.hidden = !msg;
    e.empty.textContent = msg;
  }

  _visibleRange() {
    const n = this._filtered.length;
    if (!this._virtual) return [0, n];
    const l = this._el.list;
    const h = l.clientHeight || parseFloat(this._config.max_height) || 320;
    const start = Math.max(0, Math.floor(l.scrollTop / KVC_ROW) - 6);
    return [start, Math.min(n, Math.ceil((l.scrollTop + h) / KVC_ROW) + 6)];
  }

  _renderRows(force) {
    const [a, b] = this._visibleRange();
    if (!force && this._range && this._range[0] === a && this._range[1] === b) return;
    this._range = [a, b];
    this._drawnCur = this._cur;
    this._pendingDrawn = this._pending && this._pending.name;
    const sp = this._el.spacer;
    const focusedName = this.shadowRoot.activeElement && this.shadowRoot.activeElement.classList.contains("row")
      ? this.shadowRoot.activeElement.dataset.name : null;
    const frag = document.createDocumentFragment();
    let refocus = null;
    for (let i = a; i < b; i++) {
      const name = this._filtered[i];
      const r = document.createElement("div");
      r.className = "row";
      if (name === this._cur) r.classList.add("current");
      else if (this._pendingDrawn === name) r.classList.add("pending");
      r.setAttribute("role", "option");
      r.setAttribute("aria-selected", String(name === this._cur));
      r.tabIndex = 0;
      r.dataset.name = name; r.dataset.i = String(i);
      r.style.top = `${i * KVC_ROW}px`;
      r.title = name;
      const nm = document.createElement("span");
      nm.className = "nm"; nm.textContent = name;
      r.appendChild(nm);
      if (this._favSet.has(name)) r.insertAdjacentHTML("beforeend", kvcSvg(KVC_ICON.star));
      if (name === focusedName) refocus = r;
      frag.appendChild(r);
    }
    sp.textContent = "";
    sp.appendChild(frag);
    if (refocus) refocus.focus({ preventScroll: true });
  }

  _focusRow(i) {
    if (i < 0 || i >= this._filtered.length) return;
    const l = this._el.list, top = i * KVC_ROW;
    if (top < l.scrollTop) l.scrollTop = top;
    else if (top + KVC_ROW > l.scrollTop + l.clientHeight) l.scrollTop = top + KVC_ROW - l.clientHeight;
    this._renderRows(true);
    const r = this._el.spacer.querySelector(`.row[data-i="${i}"]`);
    if (r) r.focus({ preventScroll: true });
  }

  _scrollToCurrent(smooth) {
    const i = this._filtered.indexOf(this._cur);
    if (i < 0) return;
    const l = this._el.list;
    const top = Math.max(0, i * KVC_ROW - (l.clientHeight - KVC_ROW) / 2);
    if (smooth && l.scrollTo) l.scrollTo({ top, behavior: "smooth" }); else l.scrollTop = top;
    this._renderRows(true);
  }

  _pick(name) {
    this._pending = { name, at: Date.now() };
    this._renderRows(true);
    this._call("select", "select_option", this._config.preset_entity, { option: name });
  }

  _setNumber(entity_id, raw) {
    const st = this._hass && this._hass.states[entity_id];
    if (kvcBad(st)) return;
    let v = String(raw).trim() === "" ? NaN : Number(raw);
    if (!Number.isFinite(v)) { this._update(); return; }   // blank or junk: put the real value back
    const min = Number(st.attributes.min ?? 0), max = Number(st.attributes.max ?? 100), step = Number(st.attributes.step ?? 1);
    if (step > 0) v = min + Math.round((v - min) / step) * step;
    v = Math.min(max, Math.max(min, Number(v.toFixed(4))));
    this._call("number", "set_value", entity_id, { value: v });
    this._update();
  }

  _storeKey() { return `kraken-visualizer-settings-collapsed:${this._config.preset_entity}`; }

  _setCollapsed(on, remember) {
    this._collapsed = on;
    this._el.set.classList.toggle("collapsed", on);
    this._el.sethead.setAttribute("aria-expanded", String(!on));
    if (remember) { try { localStorage.setItem(this._storeKey(), on ? "1" : "0"); } catch (e) { /* ignore */ } }
    this.dispatchEvent(new Event("iron-resize", { bubbles: true, composed: true }));
  }

  _call(domain, service, entity_id, data) {
    if (!this._hass || !entity_id) return;
    const st = this._hass.states[entity_id];
    if (kvcGone(st)) return;
    const p = this._hass.callService(domain, service, Object.assign({ entity_id }, data || {}));
    if (p && typeof p.catch === "function") p.catch(err => console.warn("kraken-visualizer-card:", err && err.message));
  }
}

if (!customElements.get("kraken-visualizer-card")) {
  customElements.define("kraken-visualizer-card", KrakenVisualizerCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "kraken-visualizer-card",
    name: "Kraken visualizer",
    description: "MilkDrop visualizer controls for the Kraken LCD: presets, packs, favourites and settings.",
    preview: false,
  });
}

if (!customElements.get("kraken-screen-card")) {
  customElements.define("kraken-screen-card", KrakenScreenCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: "kraken-screen-card", name: "Kraken screen", description: "What's on the Kraken LCD, drawn round.", preview: false });
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
