# Glyphter — size and deployment

## Why the project folder looks like ~1 GB

It isn't. The big number is **`target/`** — Rust's build cache for the
*optional* desktop window (`glyph-font-viewer.exe`). It is regenerable,
already in `.gitignore`, and is **not** part of the web app. A typical layout:

| Part | Size | What it is |
|---|---|---|
| `target/` | ~600 MB–1 GB | Rust build cache: intermediate `.exe`s (debug + release), dependency build units, fingerprints. **Regenerable** — `cargo clean` deletes it; `cargo build` recreates it. Git-ignored, never deployed. |
| `glyph-font-viewer.exe` | ~1 MB | The desktop window (optional; the web app runs without it). |
| `sample/` | ~292 KB | One sample font (PeptasiaIconFont.otf). |
| `lib/opentype.min.js` | ~167 KB | Vendored, self-contained outline decoder for SVG/PNG export (no network). |
| `app.js` + `font.js` + `style.css` + `index.html` | ~85 KB | The viewer itself. |
| `server.js` | ~4 KB | Tiny Node server (Docker) that serves the app + the persistence API. |
| `MECHANICS.md` + `mechanics.json` | ~16 KB | Documentation / constants sheet. |
| **Web app total** | **~700 KB** | *This* is all a web server needs. |

So: the app is under a megabyte; hundreds of megabytes of build cache are
counted along with it. If you want the folder back down to real size:

```
cd app
cargo clean
```

(the cached release binary stays at `target/release/glyph-font-viewer.exe`
until it's rebuilt; the copy at `app/glyph-font-viewer.exe` is untouched).

## Deploying to a web server

The web app is static: plain HTML/CSS/JS plus the font it fetches. Serve the
folder with any static server — there is no build step.

### The minimum set to copy

```
index.html
style.css
app.js
font.js
lib/            (opentype.min.js — needed for SVG/PNG export)
sample/         (PeptasiaIconFont.otf; the app fetches it by relative URL)
server.js       (optional: persistence API + Docker entrypoint)
MECHANICS.md
mechanics.json
```

(`MECHANICS.md` / `mechanics.json` are optional for a public deploy — they're
documentation.)

### Any static server

```
# Python (throwaway)
python -m http.server 8080 --directory app

# Node
npx serve app

# Nginx: point root at the app folder
```

The only requirement is that `sample/…` resolves by relative URL, because the
viewer `fetch()`es the sample font on startup. (That's also why the desktop
window serves the folder over a loopback HTTP port instead of `file://`.)

### Persistence (uploads survive a restart)

Uploaded fonts are stored **on the file system** when the app is served by the
native host or `server.js`: each upload is `POST /api/fonts` and written to
`data/fonts/<name>`. On startup the app lists and re-fetches them, so they
survive an app restart. Without a server (plain static host, or `file://`) it
falls back to the browser's IndexedDB.

In Docker, mount a volume at `data/` so uploads persist across container
rebuilds (see below).

### Docker (minimal, Alpine, no build stage)

`server.js` needs no install (plain Node `http`), so the image just copies the
static app onto `node:alpine`:

```dockerfile
# app/Dockerfile
FROM node:alpine
WORKDIR /app
COPY index.html style.css app.js font.js lib sample server.js ./
VOLUME ["/app/data"]
EXPOSE 80
ENV PORT=80
CMD ["node", "server.js"]
```

```
docker build -t glyph-font-viewer app
docker run --rm -p 8080:80 -v gfv-fonts:/app/data glyph-font-viewer
# open http://localhost:8080 — uploaded fonts persist in the gfv-fonts volume
```

### docker-compose

```yaml
# app/docker-compose.yml
services:
  glyph-font-viewer:
    build: .
    ports:
      - "8080:80"
    volumes:
      - gfv-fonts:/app/data
    restart: unless-stopped
volumes:
  gfv-fonts:
```

```
cd app
docker compose up -d --build
# then http://localhost:8080
```

### Notes

- **The desktop window is not needed on the server.** It's a convenience
  wrapper; deploying `app/glyph-font-viewer.exe` anywhere is unnecessary.
- **`data/` is created on first upload** and holds only the fonts a visitor
  uploaded (the sample font stays read-only in `sample/`).
