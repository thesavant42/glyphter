# Glyphter — Mechanics & Constants

A web rebuild of FontForge's font/glyph view: browse a font's glyphs across
the whole Unicode range in a grid, inspect one glyph large with metric guides,
and jump to any extended-Unicode character. This file records the font-format
rules and the exact constants the rebuild relies on.

## What was rebuilt, and from what

The original target `run_fontforge.exe` (121 KB) is only a **launcher**: it sets
a few environment variables and runs `bin\fontforge.exe -nosplash` via
`fontforge.bat`. The real program is FontForge, a full font editor. The rebuilt
feature set maps to FontForge's three core views:

| Original (FontForge)      | Rebuilt (web)                                  |
|---------------------------|------------------------------------------------|
| **FontView** (char grid)  | The main grid of defined glyphs                |
| **Glyph window** (inspector) | The large single-glyph view + metric guides  |
| **Font Info**             | The status bar (format, glyphs, upem, weight)  |

Sample data: `sample/PeptasiaIconFont.otf` — an icon font (933 glyphs) whose
~930 icons live in the Private Use Area. (It also doubles as the live test
case for the corrupt-cmap / scrambled-post handling documented below.)

## How the web app works

- **Rendering is done by the browser.** The app registers each loaded font
  with `new FontFace(...)` and draws glyphs with a `<canvas>` and the CSS
  `font-family`. This is the same engine that fills the grid and correctly
  handles composite glyphs and every Unicode plane the font covers — so the
  grid is always accurate regardless of the font's internals.
- **A small hand-rolled parser** (`font.js`) reads only the tables the UI
  needs, with bounds-checked reads and a per-table `try/catch`, so an unusual
  font degrades to "no name / no advance" rather than crashing the page.
- The big single-glyph view shows **only the rendered glyph** — em box,
  baseline bar and advance guide were removed at the user's request. The
  glyph is rendered by the **browser's own `FontFace`/canvas engine** (always
  correct, including composite glyphs and astral-plane characters) and
  **centred by its measured ink**: the character is drawn once offscreen with
  the same registered font, the alpha bounding box is read back, and that box
  is fitted (90% of the canvas, 5% padding) and centred in the panel — the
  same placement the grid cells get, scaled up. (`textAlign` stays `"left"`
  so the measured pen origin lands exactly where the ink-centre math puts it;
  `"center"` would re-centre the text and undo it.) A hand-outline draw path
  exists in `app.js` but is dormant: `font.js` does not expose `decodeGlyph`,
  so the hand glyf/CFF outline decoders are never reached by the app. The
  Fill / Outline / thickness pickers drive both the **live preview** and the
  export from the same `exportColors()` — WYSIWYG.
- **Vendored `opentype.js`** (`lib/opentype.min.js`, MIT, self-contained — no
  network needed) is loaded too, but is used **only for exporting** (and the
  inspector's bounding-box readout). It correctly decodes TrueType `glyf`
  outlines (including composite glyphs) and CFF/OTF Type-2 charstrings, where
  the hand-rolled parser in `font.js` is not reliable. See "Exporting a
  glyph" below.

## The font tables read (and why)

| Table | Used for                                   | Notes |
|-------|--------------------------------------------|-------|
| `head`  | `unitsPerEm` — the "em" everything is measured against | read at byte 18 (16-bit) |
| `maxp`  | `numGlyphs`                                | byte 4 |
| `name`  | family / style / full / postscript strings | names 16/17/4/6 |
| `cmap`  | codepoint → glyph id                       | **format 4** (BMP) + **format 12** (full Unicode incl. astral planes); 12 preferred when present |
| `hmtx`  | advance width per glyph                    | `numGlyphs` advances; table-length-bounded so it never reads past the end |
| `post`  | glyph names                                | format 2.0 = 16-bit Adobe Glyph List indices + custom-name pool |
| `OS/2`  | `usWeightClass`, `usWidthClass` (status bar); `sTypoAscender`/`sTypoDescender` + `usWinAscent`/`usWinDescent` (fallback em metrics when a glyph has no ink) | bounds-safe; version/length guarded. **Metric offsets are the spec's 68/70/72/74/76 — an earlier revision read them 16 bytes early (52/54/…) and silently returned 0.** |

## Key constants (PeptasiaIconFont.otf, verified by reading the bytes)

```
unitsPerEm        1000      (the em = 1000 design units; all metrics scale from this)
numGlyphs         933       (glyphs 0..932; glyph 0 is .notdef)
cmap format       4         (BMP only — all defined codepoints are < U+10000)
defined codepoints 931       (930 Private Use Area icons U+E001..U+F8FE plus U+0020 space)
advance widths    933       (one per glyph, in design units)
family / style    "Untitled" / "Regular"  (icon fonts often ship unbranded)
weight class      400
typo ascent/descent  750 / -250   (from OS/2 @68/70; the big view centres the glyph+em box using these)
```

Example verified mappings (via the validated secondary reader):
```
U+0020  space      -> glyph 482  , advance 500
U+E001  (icon)     -> glyph 30   , advance 1249  , name "uniE001"
U+E003  (icon)     -> glyph 31   , advance 1250  , name "uniE003"
U+E005  (icon)     -> glyph 762  , advance …     , name "uniE005"
```

## Rules and behaviours

1. **Grid is "Defined" or "All".** *Defined* lists only codepoints the font
   maps (388 here). *All* shows a contiguous window (1024 cells) around the
   current position within the selected plane.
2. **Plane tabs** P0..P16 (Unicode blocks) plus *All*. A plane tab shows a
   count when the font defines glyphs there.
3. **Cell cap:** at most 4096 cells are rendered at once to keep the DOM fast;
   a note tells you to narrow the plane or search for the rest.
4. **Search** accepts a hex/decimal codepoint (`1f600`, `U+20AC`, `10258`) and
   jumps straight to it, or a name/character and matches across defined glyphs.
5. **Zoom** changes the grid cell size between 72 and 320 px.
6. **Navigation:** first/prev/next/last defined glyph; arrow keys move within
   the current view; `Ctrl+[` / `Ctrl+]` move to prev/next defined.
7. **Astral-plane cells** (codepoint > U+FFFF) show the character large so the
   emoji/symbols remain legible.

## Exporting a glyph (SVG and PNG)

The inspector's **Export SVG** and **Export PNG** buttons save the currently
selected glyph to disk.

### Two export paths

- **PNG** — a straight copy of the big-view canvas (white background, black
  glyph), scaled to the display size × device-pixel-ratio. It uses the
  browser's own font renderer, so it is *always* exactly what the user sees,
  for any font, including ones the vector decoders can't handle.
- **SVG, vector** — the true outline, decoded by the vendored `opentype.js`
  (`opentype.parse(buf)` → `glyph.getPath(0, 0, unitsPerEm)` → `toPathData(3)`).
  The path commands are emitted verbatim into a `<path d="…">`; the `<svg>`
  `viewBox` spans the glyph's bounding box extended to include the baseline
  (y = 0) and the advance width, with 2 units of padding, so the exported file
  is self-contained at 1 : 1 font-unit scale.
- **SVG, raster fallback** — when `opentype.js` cannot read the outline for
  the selected codepoint (missing/corrupt `cmap`, a CFF the library refuses,
  `.notdef`, or the file failed to parse there), the export is *not* skipped:
  it becomes an `<svg>` embedding the browser's own high-resolution render as
  a base64 `<image>`. The user always gets a valid, viewable SVG; the toast
  says which kind was produced ("vector" or "raster").

### Which glyph gets exported (verified WYSIWYG)

Every character the app *draws* (grid cell, inspector sample, big view) is
rendered by the browser's font engine from the **codepoint**, so the shape on
screen follows the font's true cmap. Cells the app's own parser counts as
undefined are shown empty ("No glyph at …") even if a browser could draw
them, so the export **guard** uses the app's own `cmapGlyph(cp)` — export
succeeds exactly when the UI shows a glyph. The **outline** is resolved with
opentype's `charToGlyph(cp)` — not the app's hand parser — because:

- on well-formed fonts the two agree (1472/1472 codepoints, verified on two
  real TTF weights), so this is the same glyph either way;
- on corrupt-cmap fonts (verified with the bundled `PeptasiaIconFont.otf`) the
  **hand parser is the one that's wrong** — its format-4 `cmap` maps many
  codepoints to the same glyph id and drops others, while the secondary
  reader's mapping agrees with the font's own CFF glyph names (U+E003 → gid 31,
  named `uniE003`), which is what the browser draws in the cell.

The *guard* (whether to export at all) still uses the app's own
`cmapGlyph(cp)`, matching the grid's "defined" classification, and a
corrupt-cmap codepoint that the app counts as defined but opentype cannot
decode simply falls back to the raster path below — which is, by
construction, exactly what the screen shows.

### Coordinate convention (verified, not guessed)

`getPath(0, 0, unitsPerEm)` returns **screen-oriented** coordinates: x right,
y **down**. Verified against the raw bytes of a real TTF (a capital "A" at
upem 2048): the decoded `A` starts `M130 0 L635 -1421…` and
`getBoundingBox()` reports `{x1:130, y1:0, x2:1333, y2:1421}` — the classic
font-unit box (baseline at y = 0, cap height above it). So the SVG path is
embedded **directly, with no flip**, in a y-down viewBox where the baseline is
the top of the box.

### Limits and honest weaknesses

- **TrueType `glyf` and CFF Type-2** are both decoded correctly by
  opentype.js, including composite glyphs (the library flattens them — the
  exported path has no `<use>` references).
- **Outline-less glyphs** (e.g. the space, U+20 — mapped but with no
  contours) produce a **raster** SVG by design, not an empty file.
- **Corrupt `cmap` / `post`**: `PeptasiaIconFont.otf` is the live example
  (it ships in `sample/`). Its format-4 `cmap` maps many codepoints to the
  same glyph id (and leaves gaps), and its `post` glyph names are wrong for
  932 of 933 glyphs. The hand parser's `font.js` self-checks the cmap on load
  (each glyph id must be mapped by at most one codepoint); when it fails, it
  falls back to the vendored opentype.js cmap (`f.cmap2`) and its CFF-derived
  glyph names (`f.ot2`) and records a warning. The grid, inspector, name
  search and export then all agree with the browser's own render — verified
  against the real file: 931 defined codepoints, 0 glyph-name mismatches,
  U+E001 → gid 30 "uniE001", U+E005 → gid 762 "uniE005". The tool deliberately
  does not try to "repair" such tables; it uses the self-consistent read.
- **WOFF**: the vendored opentype build does not inflate WOFF (zlib); a
  `.woff` file still renders in the grid/inspector (browser engine) but its
  export uses the raster fallback. `.ttf` and `.otf` files get the vector
  path.
- **`seac` glyphs** (composite glyphs with fixed-width characters) and
  **hinting** (glyf instructions) are not represented in exports.

## Known quirks in the sample font (handled by the viewer, not bugs in it)

`PeptasiaIconFont.otf` is a hand-edited icon font with two quirks, both
detected and worked around at load time:

1. **Corrupt `cmap`** — the format-4 subtable maps the same glyph id to many
   codepoints (e.g. ~dozens of codepoints all point at a handful of gids) and
   leaves other icons unmapped. The self-check in `font.js` rejects it and the
   app falls back to the vendored opentype.js cmap, which matches the font's
   own CFF glyph names (931 defined codepoints; U+E001 → gid 30 "uniE001").
2. **Scrambled `post`** — the `post` table (an ASCII/icon font has no Adobe
   Glyph List) yields wrong names for 932 of 933 glyphs ("equal", "greater",
   …). When the cmap fallback triggers, `font.js` also switches glyph names to
   the CFF-derived names from the secondary reader, so the inspector, name
   search and export titles are correct.

The prominent **codepoint, the drawn character and the grid shape** were
always correct, because they come from the codepoint and the browser's font
renderer, not from the hand-parsed tables.

## How to verify without a browser

`font.js` is plain CommonJS-compatible: `require('./font.js')` then
`FontParser.load(arrayBuffer)` returns `{ ok, numGlyphs, unitsPerEm,
name, os2, cmap, advances, defined, cmapGlyph(cp), glyphName(gid), ... }`.
Loading the bundled `PeptasiaIconFont.otf` reports `ok: true`, 933 glyphs,
upem 1000, 931 defined codepoints, and one warning ("using the secondary
reader for this table" — the corrupt-cmap fallback described above).
