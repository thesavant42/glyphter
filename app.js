/* app.js — Glyphter (a web rebuild of FontForge's font/glyph view).
 *
 * Loads a TTF/OTF/WOFF font, registers it with the browser so we can *see*
 * its glyphs, and lets you browse them across the whole Unicode range:
 *   - a grid of defined glyphs (FontForge's "font view" / glyph browser)
 *   - a big single-glyph inspector with metric guides (em box, baseline,
 *     ascent/descent, advance) — drawing the real TrueType outlines when we
 *     can, otherwise the browser's own renderer
 *   - plane tabs (U+0000..U+10FFFF), Defined/All views, zoom, and a
 *     codepoint/name search that jumps straight to extended characters.
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  // ---- Unicode plane names (for the tab labels) ----
  var PLANES = [
    "Latin-1", "Latin Extended", "IPA / CJK", "CJK Unified", "Pictographs",
    "Math", "Supplemental", "Symbolic", "Private Use", "Pua-A", "Pua-B",
    "Compatibility", "Symbols", "Suppl. Symbols", "Tangut*", "Pua-C"
  ];
  var planeName = function (p) {
    if (p < 0) return "—";
    if (p > 0x10) return "P" + p;
    var n = PLANES[p];
    return "P" + p + " " + n;
  };
  var planeShort = function (p) {
    if (p < 0) return "All";
    if (p === 0) return "P0";
    return "P" + p;
  };

  // ---- state ----
  var state = {
    fonts: [],        // [{label, buf, font}]
    current: -1,
    font: null,       // active parsed font
    fontFamily: null, // registered CSS family name for the active font
    name: "No font loaded",
    defined: [],      // sorted array of defined codepoints
    byPlane: {},      // plane -> [codepoints]
    planeCount: {},   // plane -> count
    view: "defined",  // "defined" | "all"
    plane: 0,         // 0..0x10 or -1 for "all"
    cursor: 0,        // current codepoint
    anchor: 0,        // codepoint the "All" window is centred on
    cell: 160,        // grid cell size in px
    search: "",
    theme: "light",   // "light" | "dark"
    colorsTouched: false // true once the user edits the export colour pickers
  };

  var MAX_CELLS = 4096;

  // ============================ theme ============================
  // The CSS owns all the chrome colours via variables (including per-cell
  // glyph ink, which inherits --ink); only the inspector canvas draws with
  // JS colours, so a theme change just re-draws it. The choice persists in
  // localStorage and is applied pre-paint by the inline script in index.html.
  function cssVar(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name);
      return v && v.trim() ? v.trim() : fallback;
    } catch (e) { return fallback; }
  }

  function setTheme(theme) {
    state.theme = theme;
    if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    try { localStorage.setItem("gfv-theme", theme); } catch (e) {}
    var btn = $("theme-toggle");
    if (btn) {
      btn.textContent = theme === "dark" ? "☀️" : "🌙";
      btn.title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    }
    // Keep the export colour pickers in step with the theme unless the user
    // has already chosen their own colours — so a default export is white on
    // a dark theme (matching what's on screen) instead of black.
    if (!state.colorsTouched) {
      var ink = cssVar("--ink", theme === "dark" ? "#e6e9f0" : "#000000");
      var fill = $("color-fill");
      var stroke = $("color-stroke");
      if (fill) fill.value = ink;
      if (stroke) stroke.value = ink;
    }
    // Re-draw the big-view canvas: its ink and metric-guide colours are
    // resolved from the CSS variables at draw time (white glyphs on dark).
    renderInspector();
  }

  // ============================ font loading ============================
  function registerFont(buf, id) {
    var family = "LFX_" + id;
    return new Promise(function (resolve, reject) {
      try {
        var face = new FontFace(family, buf);
        document.fonts.add(face);
        face.load().then(function () { resolve(family); }, reject);
      } catch (e) { reject(e); }
    });
  }

  function addFont(buf, label, opts) {
    opts = opts || {};
    function say(msg) { if (!opts.silent) toast(msg); }
    // SVG fonts (the legacy SVG-1.1 <font>/<glyph> XML format) aren't a binary
    // sfnt and browsers can't register them with the CSS Font API, so the
    // viewer can't render them. Say so instead of silently loading an empty font.
    var isSvgFile = /\.svg$/i.test(label);
    var looksLikeSvg = false;
    if (!isSvgFile && buf.byteLength >= 5) {
      var head = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, 512));
      looksLikeSvg = head.trim().indexOf("<?xml") >= 0 && /<font[\s>]/.test(head);
    }
    if (isSvgFile || looksLikeSvg) {
      say("SVG fonts aren't supported: browsers removed the SVG Font format from the CSS " +
        "Font API, so there's no way to register one for rendering. " +
        "Use a .ttf, .otf, .woff or .woff2 instead.");
      return;
    }
    var font = FontParser.load(buf);
    if (!font.ok) {
      say("Could not read that file as a font: " + (font.errors || "unknown"));
      return;
    }
    // Don't stack a duplicate of a font that's already loaded (same name, or
    // the same bytes under a different name).
    var sig = bufSig(buf);
    var dup = -1;
    for (var d = 0; d < state.fonts.length; d++) {
      if (state.fonts[d].label === label || (state.fonts[d].sig === sig)) { dup = d; break; }
    }
    if (dup >= 0) {
      selectFont(dup, true);
      say("\"" + label + "\" is already loaded.");
      return;
    }
    state.fonts.push({ label: label, buf: buf, bufBytes: new Uint8Array(buf), font: font, sig: sig });
    if (!opts || !opts.noPersist) savePersistedFont(label, buf);
    var idx = state.fonts.length - 1;
    registerFont(buf, idx).then(function (family) {
      state.fonts[idx].family = family;
      if (idx === state.current) {
        state.fontFamily = family;
        renderGrid();
        renderInspector();
      }
    });
    selectFont(idx, opts.focus !== false);
  }

  function selectFont(idx, focus) {
    if (focus === false) {
      // Background load (an extra sample font): refresh the picker without
      // changing the current selection.
      renderFontPick();
      return;
    }
    state.current = idx;
    var entry = state.fonts[idx];
    state.font = entry.font;
    state.fontFamily = entry.family || null;
    state.name = entry.label;
    $("font-name").textContent = entry.label;
    state.defined = entry.font.defined || [];
    state.byPlane = {};
    state.planeCount = {};
    for (var i = 0; i < state.defined.length; i++) {
      var p = Math.floor(state.defined[i] / 0x10000);
      (state.byPlane[p] = state.byPlane[p] || []).push(state.defined[i]);
      state.planeCount[p] = (state.planeCount[p] || 0) + 1;
    }
    // land on the first defined glyph
    if (state.defined.length) {
      state.cursor = state.defined[0];
      state.plane = Math.floor(state.cursor / 0x10000);
    } else {
      state.cursor = 0;
      state.plane = 0;
    }
    state.anchor = state.cursor;
    renderAll();
  }

  function onFile(ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { addFont(reader.result, file.name); };
    reader.onerror = function () { toast("Could not read the file."); };
    reader.readAsArrayBuffer(file);
    ev.target.value = "";
  }

  // ============================ font persistence ============================
  // Two-tier storage so uploaded fonts survive an app restart:
  //   1. FILE SYSTEM (primary) — when the app is served by the desktop host
  //      or the small `server.js` in Docker, uploads are written to disk
  //      (./data/fonts) and restored on startup. This survives restarts and,
  //      in Docker, a mounted volume keeps them across container rebuilds.
  //   2. IndexedDB (fallback) — when there is no server (e.g. a plain static
  //      host or file://), fonts are kept in the browser instead.
  // Best-effort throughout: storage trouble never blocks the viewer.
  var API_BASE = "api/fonts";

  function httpOk(r) { return r && r.ok && (r.status < 300); }

  function serverAvailable() {
    return fetch(API_BASE, { method: "GET" })
      .then(function (r) { return httpOk(r) ? r.json() : Promise.reject(); })
      .then(function (j) { return Array.isArray(j.fonts); })
      .catch(function () { return false; });
  }

  function serverList() {
    return serverAvailable().then(function (ok) {
      return ok
        ? fetch(API_BASE).then(function (r) { return httpOk(r) ? r.json() : { fonts: [] }; })
        : Promise.resolve(null);
    }).catch(function () { return null; });
  }

  function serverSaveFont(label, bytes) {
    return fetch(API_BASE, {
      method: "POST",
      headers: { "X-File-Name": encodeURIComponent(label) },
      body: bytes
    }).then(function (r) { return httpOk(r); }).catch(function () { return false; });
  }

  function serverFetchFont(name) {
    return fetch(API_BASE + "/" + encodeURIComponent(name))
      .then(function (r) { return httpOk(r) ? r.arrayBuffer() : Promise.reject(); })
      .catch(function () { return null; });
  }

  // ---- IndexedDB fallback (unchanged behaviour, per browser/origin) ----
  var DB_NAME = "glyph-font-viewer";
  var DB_STORE = "fonts";

  function idb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error("no IndexedDB"));
      var req = window.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error("idb open failed")); };
    });
  }

  function idbSaveFont(label, bytes) {
    idb().then(function (db) {
      var tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put({ label: label, bytes: bytes });
      setTimeout(function () { try { db.close(); } catch (e) {} }, 0);
    }).catch(function () { /* storage unavailable — non-fatal */ });
  }

  function idbListFonts() {
    return idb().then(function (db) {
      var req = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).getAll();
      return new Promise(function (resolve) {
        req.onsuccess = function () {
          var out = req.result || [];
          try { db.close(); } catch (e) {}
          resolve(out);
        };
        req.onerror = function () { try { db.close(); } catch (e) {} resolve([]); };
      });
    }).catch(function () { return []; });
  }

  // ---- unified save / restore ----
  function savePersistedFont(label, bytes) {
    // Filesystem first; IndexedDB only when no server is in front of us.
    serverAvailable().then(function (ok) {
      if (ok) {
        serverSaveFont(label, bytes).then(function (saved) {
          if (!saved) idbSaveFont(label, bytes); // server rejected — keep locally
        });
      } else {
        idbSaveFont(label, bytes);
      }
    }).catch(function () { idbSaveFont(label, bytes); });
  }

  function loadPersistedFonts() {
    return serverList().then(function (listing) {
      if (listing) {
        // Filesystem store: fetch each stored font's bytes.
        var jobs = (listing.fonts || []).map(function (f) {
          return serverFetchFont(f.name).then(function (bytes) {
            return (bytes && bytes.byteLength) ? { label: f.name, bytes: bytes } : null;
          });
        });
        return Promise.all(jobs).then(function (recs) {
          return recs.filter(function (r) { return r && r.bytes.byteLength; });
        });
      }
      // No server: IndexedDB fallback.
      return idbListFonts();
    });
  }

  // Cheap content signature so we don't stack the same file twice.
  function bufSig(b) {
    var a = new Uint8Array(b), h = 2166136261 >>> 0;
    for (var i = 0; i < a.length; i++) {
      h ^= a[i];
      h = Math.imul(h, 16777619) >>> 0;
    }
    return a.length + ":" + h.toString(16);
  }

  // ============================ startup loading ============================
  function loadSamples(defaultFocus) {
    // The bundled sample font is the Peptasia icon font (933 glyphs; 900+
    // icons live in the Private Use Area). `defaultFocus` is true when no
    // persisted font was restored, so it becomes the default selection.
    var samples = [
      ["sample/PeptasiaIconFont.otf", "PeptasiaIconFont (sample)"]
    ];
    for (var i = 0; i < samples.length; i++) {
      var path = samples[i][0], label = samples[i][1];
      var first = i === 0 && defaultFocus !== false;
      fetch(path)
        .then(function (r) { return r.ok ? r.arrayBuffer() : Promise.reject("http " + r.status); })
        .then(function (buf) { addFont(buf, label, { noPersist: true, focus: first, silent: true }); })
        .catch(function () { /* sample not served (e.g. opened from file://) */ });
    }
  }

  function boot() {
    // Restored (persisted) fonts first; if there are none, the bundled sample
    // (PeptasiaIconFont.otf) becomes the default selection.
    loadPersistedFonts().then(function (stored) {
      var restored = 0;
      for (var i = 0; i < stored.length; i++) {
        var rec = stored[i];
        if (rec && rec.label && rec.bytes && rec.bytes.byteLength) {
          addFont(rec.bytes, rec.label, { noPersist: true, focus: restored === 0, silent: true });
          restored++;
        }
      }
      loadSamples(restored === 0);
      renderAll();
    });
  }

  // ============================ views / data ============================
  function planeEnd(p) { return Math.min((p + 1) * 0x10000, 0x110000); }

  function viewList() {
    if (state.view === "defined") {
      if (state.plane < 0) return state.defined.slice();
      return state.byPlane[state.plane] || [];
    }
    // "all": a contiguous window around the anchor within the current plane
    if (state.plane < 0) return state.defined.slice();
    var size = 0x400; // 1024
    var start = Math.min(planeEnd(state.plane) - size,
      Math.floor(state.anchor / size) * size);
    start = Math.max(0, start);
    var out = [];
    for (var c = start; c < Math.min(planeEnd(state.plane), start + size); c++) out.push(c);
    return out;
  }

  function isDefined(cp) {
    // binary search over the sorted defined list
    var arr = state.defined, lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
      var m = (lo + hi) >> 1;
      if (arr[m] === cp) return true;
      if (arr[m] < cp) lo = m + 1; else hi = m - 1;
    }
    return false;
  }

  // ============================ rendering ============================
  function renderAll() {
    renderStatus();
    renderPlaneTabs();
    renderFontPick();
    renderGrid();
    renderInspector();
  }

  function renderFontPick() {
    var sel = $("font-pick");
    sel.innerHTML = "";
    for (var i = 0; i < state.fonts.length; i++) {
      var o = document.createElement("option");
      o.value = i;
      o.textContent = state.fonts[i].label;
      if (i === state.current) o.selected = true;
      sel.appendChild(o);
    }
    sel.disabled = state.fonts.length <= 1;
  }

  function renderPlaneTabs() {
    var seg = $("plane-seg");
    seg.innerHTML = "";
    var mk = function (val, label, active) {
      var b = document.createElement("button");
      b.textContent = label;
      if (active) b.className = "active";
      b.addEventListener("click", function () {
        state.plane = val;
        if (state.view === "all" && state.plane < 0) state.view = "defined";
        if (state.plane >= 0) {
          var list = state.byPlane[state.plane] || [];
          state.cursor = list.length ? list[0] : planeEnd(state.plane);
        }
        if (state.view === "all") state.anchor = state.cursor;
        syncViewButtons();
        renderAll();
      });
      seg.appendChild(b);
    };
    mk(-1, "All", state.plane < 0);
    for (var p = 0; p <= 0x10; p++) {
      var lbl = planeShort(p);
      if (state.planeCount[p]) lbl += " (" + state.planeCount[p] + ")";
      mk(p, lbl, state.plane === p);
    }
  }

  function syncViewButtons() {
    var btns = document.querySelectorAll("[data-view]");
    for (var i = 0; i < btns.length; i++) {
      var active = btns[i].getAttribute("data-view") === state.view;
      btns[i].className = active ? "seg-btn active" : "seg-btn";
    }
  }

  function hex(cp) {
    return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
  }
  var hexWide = function (cp) {
    var h = cp.toString(16).toUpperCase();
    if (h.length > 4) h = h.slice(0, -4) + "-" + h.slice(-4);
    return "U+" + h;
  };

  function renderGrid() {
    var grid = $("grid");
    grid.innerHTML = "";
    var list = viewList();
    var capped = list.length > MAX_CELLS;
    if (capped) list = list.slice(0, MAX_CELLS);

    var frag = document.createDocumentFragment();
    grid.style.setProperty("--cell", state.cell + "px");

    for (var i = 0; i < list.length; i++) {
      var cp = list[i];
      var el = document.createElement("div");
      var defined = isDefined(cp);
      el.className = "cell" + (cp === state.cursor ? " active" : "") + (defined ? "" : " empty");
      el.setAttribute("data-cp", cp);
      var g = document.createElement("span");
      g.className = "glyph";
      if (state.fontFamily) g.style.fontFamily = state.fontFamily;
      g.textContent = defined ? String.fromCodePoint(cp) : "";
      el.appendChild(g);

      var cpEl = document.createElement("span");
      cpEl.className = "cp";
      cpEl.textContent = hexWide(cp);
      el.appendChild(cpEl);

      if (defined && cp > 0xffff) {
        var cp2 = document.createElement("span");
        cp2.className = "cp2";
        cp2.textContent = String.fromCodePoint(cp);
        el.appendChild(cp2);
      }

      (function (code) {
        el.addEventListener("click", function () {
          state.cursor = code;
          state.plane = Math.floor(code / 0x10000);
          renderGrid();
          renderInspector();
          renderPlaneTabs();
        });
      })(cp);

      frag.appendChild(el);
    }

    grid.appendChild(frag);

    if (capped) {
      var note = document.createElement("div");
      note.className = "grid-note";
      note.style.gridColumn = "1 / -1";
      note.textContent = "Showing the first " + MAX_CELLS + " of " +
        viewList().length + " — narrow the plane or search to jump.";
      note.style.color = "var(--ink-soft)";
      note.style.fontSize = ".8rem";
      note.style.padding = "0 4px 12px";
      grid.appendChild(note);
    }
  }

  // ============================ inspector ============================
  function decodeFor(cp) {
    var f = state.font;
    if (!f) return null;
    var gid = f.cmapGlyph ? f.cmapGlyph(cp) : 0;
    if (!gid || !f.decodeGlyph) return null;
    var gl = f.decodeGlyph(gid);
    if (!gl) return null;
    return { gid: gid, glyph: gl };
  }

  function drawGlyphOutline(ctx, glyph, t, depth) {
    depth = depth || 0;
    if (!glyph || depth > 8) return;
    if (glyph.compound) {
      for (var i = 0; i < glyph.comps.length; i++) {
        var c = glyph.comps[i];
        var sub = state.font.decodeGlyph ? state.font.decodeGlyph(c.gid) : null;
        if (sub) drawGlyphOutline(ctx, sub,
          { sx: t.sx * c.scale, sy: t.sy * c.scale, dx: t.dx + c.x, dy: t.dy + c.y }, depth + 1);
      }
      return;
    }
    for (var ci = 0; ci < glyph.contours.length; ci++) {
      var pts = glyph.contours[ci];
      if (pts.length < 3) continue;
      var n = pts.length;
      // find first on-curve point
      var i0 = 0;
      while (i0 < n && !pts[i0].on) i0++;
      if (i0 >= n) continue;
      ctx.moveTo(TX(pts[i0].x, t), TY(pts[i0].y, t));
      var offs = [];
      for (var k = 1; k <= n; k++) {
        var idx = (i0 + k) % n;
        var p = pts[idx];
        if (p.on) {
          if (offs.length === 0) ctx.lineTo(TX(p.x, t), TY(p.y, t));
          else if (offs.length === 1) ctx.quadraticCurveTo(TX(offs[0].x, t), TY(offs[0].y, t), TX(p.x, t), TY(p.y, t));
          else if (offs.length === 2) ctx.bezierCurveTo(TX(offs[0].x, t), TY(offs[0].y, t), TX(offs[1].x, t), TY(offs[1].y, t), TX(p.x, t), TY(p.y, t));
          else ctx.lineTo(TX(p.x, t), TY(p.y, t));
          offs = [];
        } else offs.push(p);
      }
      ctx.closePath();
    }
  }
  function TX(x, t) { return t.dx + x * t.sx; }
  function TY(y, t) { return t.dy - y * t.sy; }

  function renderInspector() {
    var cp = state.cursor;
    var f = state.font;

    $("cp-label").textContent = hexWide(cp);
    var sample = $("char-sample");
    sample.textContent = String.fromCodePoint(cp);
    if (state.fontFamily) sample.style.fontFamily = state.fontFamily;

    var gid = f && f.cmapGlyph ? f.cmapGlyph(cp) : 0;
    if (!gid) {
      // The Peptasia sample's hand-parsed cmap is scrambled; a codepoint the
      // hand parser misses but opentype.js (the export path) resolves is
      // still a defined glyph.
      var og = otGlyphFor(cp);
      if (og) gid = og.index;
    }
    var defined = gid > 0;

    $("m-name").textContent = defined ? (f.glyphName ? f.glyphName(gid) : ("glyph " + gid)) : "(not in font)";
    $("m-gid").textContent = defined ? gid : "—";
    var adv = defined && f.advances ? f.advances[gid] : null;
    $("m-adv").textContent = adv != null ? (adv + " u") : "—";
    $("m-plane").textContent = planeName(Math.floor(cp / 0x10000));

    var bb = $("m-bbox");
    var dec = decodeFor(cp);
    var btext = null;
    if (dec && dec.glyph.bbox) {
      var b = dec.glyph.bbox;
      btext = "[" + b.xMin + "," + b.xMax + "]×[" + b.yMin + "," + b.yMax + "]";
    }
    if (!btext && gid > 0) btext = otBBox(cp);
    bb.textContent = btext || "—";

    drawBigGlyph(cp, gid, defined, dec);
  }

  function drawBigGlyph(cp, gid, defined, dec) {
    var canvas = $("glyph");
    var ctx = canvas.getContext("2d");
    var dpr = window.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || 460;
    var cssH = canvas.clientHeight || 460;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var f = state.font;
    var upem = (f && f.unitsPerEm) || 1000;
    var adv = defined && f && f.advances ? f.advances[gid] : null;

    // Font vertical metrics as positive distances from the baseline:
    //   ascent  = em box rises this much above the baseline
    //   descent = em box drops this much below the baseline
    // Prefer OS/2 typo metrics (sTypoAscender is +, sTypoDescender is −),
    // then win metrics (both +), then the legacy full-upem assumption.
    var os2 = (f && f.os2) || null;
    var ascent, descent, haveMetrics = false;
    if (os2 && +os2.sTypoAscender > 0) {
      ascent = os2.sTypoAscender;
      descent = os2.sTypoDescender != null ? -os2.sTypoDescender : 0;
      haveMetrics = true;
    } else if (os2 && +os2.usWinAscent > 0) {
      ascent = os2.usWinAscent;
      descent = os2.usWinDescent || 0;
      haveMetrics = true;
    }
    if (!haveMetrics) { ascent = upem; descent = 0; }

    // Placement: measure the character's ACTUAL rendered ink (same registered
    // font the grid cells use) and centre it in the panel — the same
    // placement the small cells get, scaled up. No em box (the
    // user doesn't need it); a short baseline spans the ink below it. Empty
    // glyph (space, .notdef): pen origin centred.
    var pad = 0.05 * Math.min(cssW, cssH);
    var ink = state.fontFamily ? inkBox(cp, upem, adv) : null;
    var spanX = ink ? (ink.x2 - ink.x1) : upem;
    var spanY = ink ? (ink.y2 - ink.y1) : ascent + descent;
    var s = (Math.min(cssW, cssH) - 2 * pad) / Math.max(spanX, spanY);
    var gx_c = ink ? (ink.x1 + ink.x2) / 2 : 0;
    var gy_c = ink ? (ink.y1 + ink.y2) / 2 : (ascent - descent) / 2;
    var originX = cssW / 2 - s * gx_c;          // centre the ink horizontally
    var baselineY = cssH / 2 + s * gy_c;        // centre the ink vertically (y-up -> +)

    // No guides: the big view behaves exactly like the grid cells — just the
    // rendered glyph, centred. (The em box, full-width baseline and advance
    // guide were removed at the user's request; the numbers stay available
    // in the details pane below: name, gid, advance, bbox.)
    var inkRgb = cssVar("--ink-rgb", "31,36,48");

    if (!defined) {
      ctx.fillStyle = "rgba(" + inkRgb + ",.4)";
      ctx.font = "20px system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("No glyph at " + hexWide(cp), cssW / 2, cssH / 2);
      return;
    }

    // glyph: real outlines for TrueType, native renderer otherwise.
    // Drawn at (originX, baselineY) — the ink box centre in the panel.
    // Fill + outline come from the SAME source the export uses (exportColors)
    // so the preview is a true WYSIWYG of what gets exported.
    var col = exportColors();
    ctx.fillStyle = col.fill;
    if (dec && (dec.glyph.contours || (dec.glyph.compound))) {
      ctx.beginPath();
      drawGlyphOutline(ctx, dec.glyph, { sx: s, sy: s, dx: originX, dy: baselineY }, 0);
      if (col.width > 0) {
        ctx.lineWidth = col.width;
        ctx.strokeStyle = col.stroke;
        ctx.lineJoin = "round";
        ctx.stroke("evenodd");
      }
      ctx.fill("evenodd");
    } else if (state.fontFamily) {
      // text-align "left": the pen origin lands exactly at (originX, baselineY),
      // which is what the ink measurement (inkBox) was computed for. "center"
      // would re-centre the text on originX and undo the offset.
      ctx.font = (upem * s) + "px " + state.fontFamily;
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      if (col.width > 0) {
        ctx.lineWidth = col.width;
        ctx.strokeStyle = col.stroke;
        ctx.lineJoin = "round";
        ctx.strokeText(String.fromCodePoint(cp), originX, baselineY);
      }
      ctx.fillText(String.fromCodePoint(cp), originX, baselineY);
    }
  }

  function line(ctx, x1, y1, x2, y2, label) {
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  // ============================ status ============================
  function renderStatus() {
    var f = state.font;
    $("stat-format").textContent = f ? ("format: " + (f.flavor || "?")) : "";
    $("stat-glyphs").textContent = f ? ("glyphs: " + (f.numGlyphs || 0)) : "";
    $("stat-upem").textContent = f ? ("upem: " + (f.unitsPerEm || 0)) : "";
    var total = state.defined ? state.defined.length : 0;
    var planes = Object.keys(state.planeCount).length;
    $("stat-defined").textContent = "defined: " + total + (planes ? " across " + planes + " plane(s)" : "");

    var os2 = $("stat-os2");
    if (f && f.name && f.name.family) {
      var parts = [f.name.family];
      if (f.name.style) parts.push(f.name.style);
      if (f.os2 && f.os2.usWeightClass) parts.push("weight " + f.os2.usWeightClass);
      if (f.os2 && f.os2.usWidthClass && f.os2.usWidthClass !== 5) parts.push("width " + f.os2.usWidthClass);
      os2.innerHTML = "<b>" + esc(parts.join(" ")) + "</b>" +
        (f.name.postscript ? "  ·  " + esc(f.name.postscript) : "");
    } else os2.textContent = "";
  }

  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  // ============================ navigation ============================
  function jumpList() { return viewList(); }

  function nav(delta) {
    var list = jumpList();
    if (!list.length) return;
    var idx = list.indexOf(state.cursor);
    var ni = idx < 0 ? 0 : Math.min(list.length - 1, Math.max(0, idx + delta));
    setCursor(list[ni]);
  }
  function navDefined(delta) {
    var arr = state.defined;
    if (!arr.length) return;
    var idx = 0, lo = 0, hi = arr.length - 1;
    while (lo <= hi) { var m = (lo + hi) >> 1; if (arr[m] === state.cursor) { idx = m; break; } if (arr[m] < state.cursor) lo = m + 1; else hi = m - 1; }
    var ni = Math.min(arr.length - 1, Math.max(0, idx + delta));
    setCursor(arr[ni]);
  }
  function setCursor(cp) {
    state.cursor = cp;
    state.plane = Math.floor(cp / 0x10000);
    renderGrid();
    renderInspector();
    renderPlaneTabs();
  }

  function parseSearch(q) {
    q = (q || "").trim();
    if (!q) return null;
    var m = q.match(/^(?:u\+|0x)?([0-9a-f]+)$/i);
    if (m) { var v = parseInt(m[1], 16); if (v >= 0 && v <= 0x10ffff) return { cp: v }; }
    if (/^\d+$/.test(q)) { var d = parseInt(q, 10); if (d <= 0x10ffff) return { cp: d }; }
    return { text: q };
  }

  function doSearch() {
    var q = state.search = $("search").value;
    var parsed = parseSearch(q);
    if (!parsed) return;
    if (parsed.cp != null) {
      var defined = isDefined(parsed.cp);
      if (defined) setCursor(parsed.cp);
      else {
        // land on the plane, show the (empty) cell in the All view
        state.plane = Math.floor(parsed.cp / 0x10000);
        state.view = "all";
        state.anchor = parsed.cp;
        syncViewButtons();
        renderAll();
        toast(hexWide(parsed.cp) + " is not in this font (shown in All view).");
      }
      return;
    }
    // name / character search over defined codepoints
    var term = parsed.text.toLowerCase();
    var hits = [];
    for (var i = 0; i < state.defined.length; i++) {
      var cp = state.defined[i];
      var gid = state.font.cmapGlyph ? state.font.cmapGlyph(cp) : 0;
      var nm = gid > 0 && state.font.glyphName ? state.font.glyphName(gid) : "";
      if (nm.toLowerCase().indexOf(term) >= 0) hits.push(cp);
      else if (String.fromCodePoint(cp).toLowerCase() === term) hits.push(cp);
      if (hits.length >= 200) break;
    }
    if (hits.length) {
      setCursor(hits[0]);
      toast(hits.length + " match" + (hits.length > 1 ? "es" : "") + " — showing the first. Use the grid to browse.");
    } else {
      toast("No glyph named/character matches “" + parsed.text + "”.");
    }
  }

  // ============================ toast ============================
  var toastTimer = null;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }

  // ============================ export ============================
  // Vector export is done by the vendored opentype.js (app/lib/opentype.min.js,
  // browser global `opentype`), which correctly decodes TrueType `glyf` (incl.
  // composite glyphs) and CFF/OTF Type-2 charstrings. It is used ONLY for
  // export; the viewer grid/inspector keep using the browser's own FontFace
  // renderer, which is always correct.
  //
  // Coordinates: opentype's getPath(0,0,upem) already returns SCREEN-oriented
  // (y-down) coordinates, so the SVG path is embedded directly with a y-down
  // viewBox — no manual flip. Verified against raw bytes of a real TTF
  // (a capital "A" -> M130 0 L635 -1421…, bbox {130,0,1333,1421} at upem 2048).
  function ensureOtf() {
    var entry = state.fonts[state.current];
    if (!entry) return null;
    if (entry.otf) return entry.otf;
    if (typeof opentype === "undefined") { entry.otf = null; return null; }
    try { entry.otf = opentype.parse(entry.buf); }
    catch (e) { entry.otf = null; }
    return entry.otf;
  }

  // Resolve the glyph the user is looking at for a codepoint. The grid and
  // inspector draw pixels by handing the codepoint to the browser's font
  // engine, so the correct outline is opentype's charToGlyph(cp) — it matches
  // the app's own parser on well-formed fonts (1472/1472 verified on two real
  // TTF weights) and is the correct read on corrupt-cmap fonts (verified:
  // Peptasia's glyph *names* match opentype's mapping, U+E003 -> gid 31
  // "uniE003", while the hand parser's cmap is the scrambled one). Returns the
  // opentype glyph or null.
  function otGlyphFor(cp) {
    var f = ensureOtf();
    if (!f) return null;
    var g;
    try { g = f.charToGlyph(String.fromCodePoint(cp)); } catch (e) { g = null; }
    return (g && g.index != null) ? g : null;
  }

  // Bounding box (font units, y-up) for the inspector readout.
  function otBBox(cp) {
    var g = otGlyphFor(cp);
    if (!g) return null;
    var b; try { b = g.getBoundingBox(); } catch (e) { return null; }
    if (!b) return null;
    return "[" + Math.round(b.x1) + "," + Math.round(b.x2) + "]×[" + Math.round(b.y1) + "," + Math.round(b.y2) + "]";
  }

  // Bounding box of the ACTUAL rendered ink (font units, y-up), measured by
  // drawing the character once on an offscreen canvas with the same
  // registered font the grid cells use. This is what makes the big view
  // match the small cells exactly: opentype's getBoundingBox includes Bezier
  // control points and is not where the pixels end up, and metric boxes
  // (em) don't reflect an icon font's offset layout at all.
  var inkCache = {};
  function inkBox(cp, upem, adv) {
    var key = state.fontFamily + ":" + cp;
    if (key in inkCache) return inkCache[key];
    var F = Math.min(upem, 512);            // font size in px; 1 px = upem/F units
    var u = upem / F;                       // font units per px
    var W = Math.ceil(2 * F + (adv ? adv / u : F)); // pen origin at x = F, extra right for the advance
    var H = 2 * F;                          // pen origin at y = F, covers ±1 em
    var c = document.createElement("canvas");
    c.width = W; c.height = H;
    var x2 = c.getContext("2d");
    x2.font = F + "px " + state.fontFamily;
    x2.textAlign = "left"; x2.textBaseline = "alphabetic";
    x2.fillText(String.fromCodePoint(cp), F, F);
    var d = x2.getImageData(0, 0, W, H).data;
    var minx = W, miny = H, maxx = -1, maxy = -1;
    for (var y = 0; y < H; y++) {
      var row = y * W * 4;
      for (var x = 0; x < W; x++) {
        if (d[row + x * 4 + 3] > 16) {       // alpha: rendered ink
          if (x < minx) minx = x; if (x > maxx) maxx = x;
          if (y < miny) miny = y; if (y > maxy) maxy = y;
        }
      }
    }
    var r = null;
    if (maxx >= 0) r = { x1: (minx - F) * u, x2: (maxx - F) * u,
                         y1: (F - maxy) * u, y2: (F - miny) * u };
    if (Object.keys(inkCache).length > 400) inkCache = {};   // bounded cache
    inkCache[key] = r;
    return r;
  }

  // Outline for export: returns { d, x1, y1, x2, y2, advance, upem, name } in
  // screen units (y-down), or null when no readable outline exists.
  function otGlyphData(cp) {
    var f = ensureOtf();
    if (!f) return null;
    var g = otGlyphFor(cp);
    if (!g) return null;
    var upem = f.unitsPerEm || 1000;
    var path;
    try { path = g.getPath(0, 0, upem); } catch (e) { return null; }
    var cmds = path.commands || [];
    if (!cmds.length) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < cmds.length; i++) {
      var c = cmds[i];
      if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
      if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y;
      if (c.x1 != null) { if (c.x1 < minX) minX = c.x1; if (c.x1 > maxX) maxX = c.x1; if (c.y1 < minY) minY = c.y1; if (c.y1 > maxY) maxY = c.y1; }
      if (c.x2 != null) { if (c.x2 < minX) minX = c.x2; if (c.x2 > maxX) maxX = c.x2; if (c.y2 < minY) minY = c.y2; if (c.y2 > maxY) maxY = c.y2; }
    }
    var d; try { d = path.toPathData(3); } catch (e) { d = null; }
    if (!d) return null;
    return { d: d, x1: minX, y1: minY, x2: maxX, y2: maxY, advance: g.advanceWidth, upem: upem, name: g.name };
  }

  function r3(x) { return Math.round(x * 1000) / 1000; }

  // Shared, tight export region (font units, y-down). The SVG and PNG exports
  // both use these bounds so they match exactly.
  function glyphExportBounds(data) {
    var pad = 2;
    var x1 = Math.min(0, data.x1 - pad);
    var y1 = Math.min(0, data.y1 - pad);
    var x2 = Math.max(data.advance || 0, data.x2 + pad);
    var y2 = Math.max(0, data.y2 + pad);
    return { x1: x1, y1: y1, x2: x2, y2: y2, w: Math.max(1, x2 - x1), h: Math.max(1, y2 - y1) };
  }

  // Export colours: fill (primary) and outline (secondary), read from the
  // inspector controls so the user picks the colours before exporting.
  function exportColors() {
    var f = $("color-fill").value || "#000000";
    var s = $("color-stroke").value || "#000000";
    var w = parseInt($("stroke-width").value, 10); if (isNaN(w)) w = 0;
    return { fill: f, stroke: s, width: Math.max(0, Math.min(80, w)) };
  }

  function buildSvg(cp, data, col) {
    var fam = state.name || "glyph";
    var b = glyphExportBounds(data);
    var x1 = b.x1, y1 = b.y1, w = b.w, h = b.h;
    var gAttrs = "fill=\"" + col.fill + "\"";
    if (col.width > 0) {
      gAttrs += " stroke=\"" + col.stroke + "\" stroke-width=\"" + col.width + "\" stroke-linejoin=\"round\"";
    }
    var svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"" + r3(x1) + " " + r3(y1) + " " + r3(w) + " " + r3(h) + "\" width=\"" + r3(w) + "\" height=\"" + r3(h) + "\">\n";
    svg += "  <title>" + esc(fam) + " — U+" + hexWide(cp) + (data.name ? " (" + esc(data.name) + ")" : "") + "</title>\n";
    svg += "  <g " + gAttrs + ">\n";
    svg += "    <path d=\"" + data.d + "\"/>\n";
    svg += "  </g>\n";
    svg += "</svg>\n";
    return svg;
  }

  // Raster fallback: the browser's own renderer draws the character, so the
  // exported picture is always exactly what the user sees. Returns a data URL.
  function rasterDataUrl(cp) {
    var size = 640;
    var canvas = document.createElement("canvas");
    canvas.width = size; canvas.height = size;
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = "#000000";
    ctx.font = (size * 0.72) + "px " + (state.fontFamily || "sans-serif");
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String.fromCodePoint(cp), size / 2, size / 2);
    return canvas.toDataURL("image/png");
  }

  function downloadBlob(blob, filename, msg) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast(msg);
  }

  function slug(cp, gid) {
    return hex(cp) + "-g" + gid;
  }

  function exportSVG() {
    var f = state.font;
    if (!f) { toast("Load a font first."); return; }
    var cp = state.cursor;
    var gid = f.cmapGlyph ? f.cmapGlyph(cp) : 0;
    if (!gid) { toast(hexWide(cp) + " has no glyph in this font."); return; }
    var data = otGlyphData(cp);
    var col = exportColors();
    var svgText;
    var vector = false;
    if (data && data.d) {
      svgText = buildSvg(cp, data, col);
      vector = true;
    } else {
      var img = rasterDataUrl(cp);
      var w = 640, h = 640;
      svgText = "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 " + w + " " + h + "\" width=\"" + w + "\" height=\"" + h + "\">\n";
      svgText += "  <title>" + esc(state.name || "glyph") + " — " + hexWide(cp) + "</title>\n";
      svgText += "  <!-- raster fallback: opentype could not decode this outline (CFF / corrupt cmap / WOFF); image is the browser's own render -->\n";
      svgText += "  <image width=\"" + w + "\" height=\"" + h + "\" href=\"" + img + "\" xlink:href=\"" + img + "\"/>\n";
      svgText += "</svg>\n";
    }
    downloadBlob(new Blob([svgText], { type: "image/svg+xml" }), slug(cp, gid) + ".svg",
      "Exported " + hexWide(cp) + " as SVG (" + (vector ? "vector" : "raster") + ").");
  }

  function exportPNG() {
    var f = state.font;
    if (!f) { toast("Load a font first."); return; }
    var cp = state.cursor;
    var gid = f.cmapGlyph ? f.cmapGlyph(cp) : 0;
    if (!gid) { toast(hexWide(cp) + " has no glyph in this font."); return; }

    // Render the CLEAN outline — the same path the SVG export uses — onto a
    // transparent canvas. No metric guides, no em-box, no white fill, and it is
    // cropped to the glyph (the same region as the SVG's viewBox), so the PNG
    // matches the good SVG instead of being a screenshot of the inspector.
    var data = otGlyphData(cp);
    var col = exportColors();
    var canvas = null;
    var vector = false;
    if (data && data.d) {
      var b = glyphExportBounds(data);
      var scale = 1024 / (data.upem || 1000); // 1 em -> ~1024 px
      var c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(b.w * scale));
      c.height = Math.max(1, Math.round(b.h * scale));
      var ctx = c.getContext("2d");
      try {
        // transparent background (nothing is painted underneath)
        ctx.scale(scale, scale);
        ctx.translate(-b.x1, -b.y1);
        var p2 = new Path2D(data.d); // same path the SVG uses
        ctx.fillStyle = col.fill;
        ctx.fill(p2);
        if (col.width > 0) {
          ctx.strokeStyle = col.stroke;
          ctx.lineWidth = col.width;
          ctx.lineJoin = "round";
          ctx.stroke(p2);
        }
        canvas = c;
        vector = true;
      } catch (e) {
        canvas = null; // Path2D unavailable -> raster render below
      }
    }
    if (!canvas) {
      // No readable outline (CFF / corrupt cmap / WOFF / space): the browser's
      // own renderer draws it, still on a transparent background.
      var rc = document.createElement("canvas");
      rc.width = 640; rc.height = 640;
      drawRaster(rc.getContext("2d"), rc, cp, col.fill);
      canvas = rc;
    }
    canvas.toBlob(function (blob) {
      if (!blob) { toast("Could not create the PNG."); return; }
      downloadBlob(blob, slug(cp, gid) + ".png",
        "Exported " + hexWide(cp) + " as PNG (" + (vector ? "vector" : "raster") + ", transparent).");
    }, "image/png");
  }

  // Draw the character with the browser's own renderer, centred, on a
  // transparent canvas (no background fill, no metric guides).
  function drawRaster(ctx, canvas, cp, color) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = color || "#000000";
    ctx.font = (canvas.width * 0.72) + "px " + (state.fontFamily || "sans-serif");
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String.fromCodePoint(cp), canvas.width / 2, canvas.height / 2);
  }

  // ============================ wiring ============================
  function wire() {
    // Restore the saved theme (the inline script in index.html already
    // applied it pre-paint; this keeps state + the button label in sync).
    var savedTheme = "light";
    try { savedTheme = localStorage.getItem("gfv-theme") || "light"; } catch (e) {}
    setTheme(savedTheme === "dark" ? "dark" : "light");
    $("theme-toggle").addEventListener("click", function () {
      setTheme(state.theme === "dark" ? "light" : "dark");
    });

    $("zoom-label").textContent = state.cell + " px";
    $("file").addEventListener("change", onFile);
    $("font-pick").addEventListener("change", function (e) { selectFont(parseInt(e.target.value, 10)); });

    document.querySelectorAll("[data-view]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.view = b.getAttribute("data-view");
        syncViewButtons();
        renderAll();
      });
    });

    $("zoom-in").addEventListener("click", function () {
      state.cell = Math.min(320, state.cell + 20);
      $("zoom-label").textContent = state.cell + " px";
      renderGrid(); });
    $("zoom-out").addEventListener("click", function () {
      state.cell = Math.max(72, state.cell - 20);
      $("zoom-label").textContent = state.cell + " px";
      renderGrid(); });

    $("search").addEventListener("input", function () { state.search = this.value; });
    $("search").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); doSearch(); }
    });
    $("search-go").addEventListener("click", doSearch);

    $("nav-first").addEventListener("click", function () { if (state.defined.length) setCursor(state.defined[0]); });
    $("nav-last").addEventListener("click", function () { if (state.defined.length) setCursor(state.defined[state.defined.length - 1]); });
    $("nav-prev").addEventListener("click", function () { navDefined(-1); });
    $("nav-next").addEventListener("click", function () { navDefined(1); });

    $("export-svg").addEventListener("click", exportSVG);
    $("export-png").addEventListener("click", exportPNG);

    // colour pickers: the live preview uses the same values as the export
    // (exportColors), so any change redraws the big view immediately
    ["color-fill", "color-stroke"].forEach(function (id) {
      $(id).addEventListener("input", function () {
        state.colorsTouched = true;
        renderInspector();
      });
    });
    $("stroke-width").addEventListener("input", function () {
      state.colorsTouched = true;
      $("stroke-val").textContent = this.value;
      renderInspector();
    });

    document.addEventListener("keydown", function (e) {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "]") { e.preventDefault(); navDefined(1); }
      else if ((e.ctrlKey || e.metaKey) && e.key === "[") { e.preventDefault(); navDefined(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); nav(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); nav(-1); }
    });

    window.addEventListener("resize", function () { renderInspector(); });
  }

  // boot: restore persisted fonts, load the bundled samples, draw
  document.addEventListener("DOMContentLoaded", function () {
    wire();
    boot();
  });
})();
