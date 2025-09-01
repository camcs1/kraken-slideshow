# Kraken Media Slideshow (with Configure UI, Drag-Drop, and Preview)

This project lets you run a fully custom media slideshow on an **NZXT Kraken LCD** using the CAM **Web Integration** feature.  
It supports images (`png`, `jpg`, `gif`, `webp`) and video (`mp4`, `webm`) with flexible intervals and cropping options designed for the Kraken’s circular screen.

---

## Features
- **Configure button support**: When you click **Configure** in CAM, a configuration UI opens.
- **Drag-and-drop playlist editor**: Add, remove, and reorder media URLs with simple handles.
- **Per-item options**: Add JSON options for each item, e.g.
    - Images: `{ "seconds": 45 }` for custom duration
    - Videos: `{ "loop": true, "maxSeconds": 8 }`
    - Scheduled: `{ "at": "16:20" }` to show at 4:20 PM daily (add `{ "only": true }` to hide from normal rotation)
- **Global options**:
  - Image interval and video max length
  - Object fit: `contain` or `cover`
  - Background color
  - Circular mask vs. square
  - Circle padding (to avoid clipping on the edge)
  - Optional ring border (width + color)
  - Zoom, X/Y offset, rotation
- **Live Preview inside Configure**: Test the slideshow with current unsaved settings before saving.
- **Device playback**: When opened with `?kraken=1`, the page runs on the Kraken LCD using saved settings.

---

## How it works
- CAM opens **two browser instances** for each integration:
  - The **Kraken Browser** (with `?kraken=1`) → renders the slideshow on the pump screen.
  - The **Configuration Browser** (without the query) → shows the editor UI.
- Both contexts share the same `localStorage`. The config you save in the editor is immediately available to the device renderer.

---

## Installation
1. Clone or download this repository.
2. Copy `index.html` and `.nojekyll` to a **public GitHub Pages repo**.  
   - Example: `https://github.com/YOURUSER/kraken-slideshow`
3. Enable Pages: **Settings → Pages → Branch → main → /(root)**.
4. In NZXT CAM → **Lighting → Web Integration**, set the URL to your Pages site root:  
```

[https://YOURUSER.github.io/kraken-slideshow/index.html](https://YOURUSER.github.io/kraken-slideshow/index.html)

```

---

## Usage
1. In CAM, click the integration’s **Configure** button.  
- Add media items by URL.  
- Optionally supply per-item JSON options.  
- Drag and drop to reorder.
2. Adjust global options (intervals, scaling, circle crop, offsets, etc.).
3. Click **Preview** to see a live test of the current unsaved settings.
4. Click **Save** to store your configuration in localStorage.
5. The Kraken Browser (`?kraken=1`) automatically reads those saved settings and plays the slideshow.

---

## Example Playlist Entries
```

[https://www.gstatic.com/webp/gallery/1.webp](https://www.gstatic.com/webp/gallery/1.webp)
[https://media.giphy.com/media/l0HlQ7LRal8X9sWzO/giphy.gif](https://media.giphy.com/media/l0HlQ7LRal8X9sWzO/giphy.gif)
[https://example.com/clip.mp4](https://example.com/clip.mp4) {"loop"\:true,"maxSeconds":10}
[https://example.com/image2.jpg](https://example.com/image2.jpg) {"seconds":60}
  [https://example.com/snoop.jpg](https://example.com/snoop.jpg) {"at":"16:20","only":true}

```

---

## Notes & Tips
- **Circle padding** (default 4%) ensures content isn’t clipped on the very edge of the Kraken’s round LCD.
- **Zoom + offsets** help you center subjects inside the circle.
- The **Preview** inside Configure is only for you — the Kraken continues running its own browser instance.
- All data is stored in your PC’s **localStorage**. Each PC has its own saved config.

---

Enjoy your fully custom Kraken slideshow!

