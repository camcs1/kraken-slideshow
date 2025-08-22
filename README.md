# Kraken GIF Slideshow (GitHub Pages)

A minimal web integration page for NZXT Kraken devices that shows a slideshow of GIFs with longer intervals than the default carousel.
## Quickstart
 - Clone this repo
 - Goto repo settings -> Pages
 - Set the source to deploy from branch
 - Set the branch to main /(root) and hit save

## Use in NZXT CAM
- In CAM → Lighting → Web Integration → Edit, paste your Pages URL.
- CAM adds `?kraken=1` automatically when rendering on the device. 
- You can also override the interval from CAM by appending `?interval=45` (seconds), for example:
  - `https://<your-user>.github.io/kraken-slideshow/?interval=45`

## Customize
- Open `index.html` and replace the `gifs` array with your own HTTPS GIF URLs.
- Change `defaultIntervalSeconds` to your preferred default.
- The CSS already scales to the Kraken screen.

## Notes
- Keep the repo public so Pages can serve the files without auth.
