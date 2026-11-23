# Third-party notices

This project's own code is released into the public domain under the
Unlicense (see [LICENSE](LICENSE)). The third-party works below are used or
adapted and remain under their own terms.

## Ported into this repository

### MilkDrop 2 / MilkDrop3: song-title animation

`index.html` ports the fly-in formulas (scale, alpha and the six-sine wobble)
of `CPlugin::ShowSongTitleAnim` from `vis_milk2/milkdropfs.cpp`
(<https://github.com/milkdrop2077/MilkDrop3>).

Copyright 2005-2013 Nullsoft, Inc. BSD-style licence, reproduced in full in
`index.html` next to the ported code. This project is not endorsed by Nullsoft.

## Loaded at runtime (not included in this repository)

- **Butterchurn** 2.6.7, <https://github.com/jberg/butterchurn>.
  MIT License, Copyright (c) 2013-2018 Jordan Berg. Loaded from cdn.jsdelivr.net.
- **butterchurn-presets** 2.4.7, <https://github.com/jberg/butterchurn-presets>.
  MIT License, Copyright (c) 2013-2018 Jordan Berg. Loaded from cdn.jsdelivr.net.
- **butterchurn-presets-weekly** 0.0.4,
  <https://www.npmjs.com/package/butterchurn-presets-weekly>. Declared MIT in its
  package.json (Jordan Berg). Preset files are fetched from the butterchurn-presets
  S3 bucket.
- The MilkDrop presets themselves are the work of many preset authors (Geiss,
  Flexi, Martin, Rovastar and others); their names are shown with each preset.

## Installed separately by the user

- **SoundCard** (Python), <https://github.com/bastibe/SoundCard>. BSD 3-Clause.
- **NumPy** (installed with SoundCard), <https://numpy.org>. BSD 3-Clause.

## Acknowledgements (no code used)

- Ryan Geiss and Nullsoft, for MilkDrop.
- milkdrop2077, for MilkDrop3.
- mrgogo7's [nzxt-esc](https://github.com/mrgogo7/nzxt-esc), whose NowPlaying
  companion showed that a CAM web integration can reach a localhost WebSocket.
