/* font.js — a small, crash-proof TrueType / OpenType font reader for the
 *   Glyphter.
 *
 * It reads just the tables the web UI needs, with bounds-checked reads and a
 * per-table try/catch, so a malformed or unusual font degrades gracefully
 * instead of throwing and blanking the page:
 *
 *   head   -> unitsPerEm (the "em" size everything is measured against)
 *   maxp   -> numberOfGlyphs
 *   name   -> family / style / full / postscript names
 *   cmap   -> codepoint -> glyph id  (format 4 for the BMP, format 12 for the
 *                full Unicode range including supplementary / "astral" planes)
 *   hmtx   -> advance width per glyph
 *   post   -> glyph names (Adobe Glyph List indices / custom names)
 *
 * The actual *rendering* of glyphs is left to the browser (FontFace + canvas
 * in app.js), which is the same engine that fills the grid and correctly
 * handles composite glyphs and any Unicode plane the font covers.
 */
(function (global) {
  "use strict";

  // The standard Adobe Glyph List (258 entries). OpenType fonts whose post
  // table is format 2.0 name glyphs by index into this list.
  var AGL = [
    ".notdef", "space", "exclam", "quotedbl", "numbersign", "dollar", "percent",
    "ampersand", "quotesingle", "parenleft", "parenright", "asterisk", "plus",
    "comma", "hyphen", "period", "slash", "zero", "one", "two", "three", "four",
    "five", "six", "seven", "eight", "nine", "colon", "semicolon", "less",
    "equal", "greater", "question", "at", "A", "B", "C", "D", "E", "F", "G", "H",
    "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W",
    "X", "Y", "Z", "bracketleft", "backslash", "bracketright", "asciicircum",
    "underscore", "grave", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k",
    "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
    "braceleft", "bar", "braceright", "asciitilde", "exclamdown", "cent",
    "sterling", "currency", "yen", "brokenbar", "section", "dieresis", "copyright",
    "quoteright", "guillemotleft", "logicalnot", "registeredsign", "macron",
    "degree", "plusminus", "twosuperior", "threesuperior", "acute", "mu",
    "paragraph", "periodcentered", "cedilla", "onesuperior", "ordfeminine",
    "guillemotright", "onequarter", "onehalf", "threequarters", "questiondown",
    "agrave", "aacute", "acircumflex", "atilde", "adieresis", "aring",
    "ae", "ccedilla", "egrave", "eacute", "ecircumflex", "edieresis",
    "igrave", "iacute", "icircumflex", "idieresis", "eth", "ntilde", "ograve",
    "oacute", "ocircumflex", "otilde", "odieresis", "multiply", "ugrave",
    "uacute", "ucircumflex", "udieresis", "yacute", "thorn", "ydiaeresis",
    "amacron", "acaron", "abreve", "acomflex", "adieresis", "aogonek",
    "ccircumflex", "ccaron", "dcaron", "ecaron", "gbreve", "gcircumflex",
    "gcaron", "lacute", "lcaron", "nacute", "ncaron", "ispace", "scaron",
    "tcircumflex", "tcaron", "zacute", "zcaron", "ezacute"
  ];

  // ---- a bounds-checked DataView reader --------------------------------
  function Reader(buf) {
    var dv = new DataView(buf);
    var len = buf.byteLength;
    function ok(o, n) { return o >= 0 && o + n <= len; }
    return {
      len: len,
      u8: function (o) { return ok(o, 1) ? dv.getUint8(o) : null; },
      i8: function (o) { return ok(o, 1) ? dv.getInt8(o) : null; },
      u16: function (o) { return ok(o, 2) ? dv.getUint16(o, false) : null; },
      i16: function (o) { return ok(o, 2) ? dv.getInt16(o, false) : null; },
      u32: function (o) { return ok(o, 4) ? dv.getUint32(o, false) : null; },
      i32: function (o) { return ok(o, 4) ? dv.getInt32(o, false) : null; },
      fixed: function (o) { return ok(o, 4) ? (dv.getInt16(o) << 16) | dv.getUint16(o + 2) : null; },
      tag: function (o) {
        if (!ok(o, 4)) return "";
        return String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1),
          dv.getUint8(o + 2), dv.getUint8(o + 3));
      },
      u16str: function (o, n) {
        if (!ok(o, n * 2)) return "";
        var s = "";
        for (var i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(o + i * 2, false));
        return s;
      }
    };
  }

  // ---- name table ------------------------------------------------------
  function parseName(r, base) {
    var count = r.u16(base + 2), strOff = r.u16(base + 4);
    var names = {};
    for (var i = 0; i < count; i++) {
      var rec = base + 6 + i * 12;
      if (r.u16(rec + 8) === null) break;
      var platform = r.u16(rec), enc = r.u16(rec + 2), nameId = r.u16(rec + 6);
      var length = r.u16(rec + 8), off = r.u16(rec + 10);
      var key = platform + "_" + enc + "_" + nameId;
      if (names[key]) continue;
      var start = base + strOff + off;
      if (platform === 3 || platform === 0) names[key] = r.u16str(start, length >> 1);
      else {
        var t = "";
        for (var b = 0; b < length; b++) t += String.fromCharCode(r.u8(start + b) || 0);
        names[key] = t;
      }
    }
    function pick(id, plats) {
      for (var p = 0; p < plats.length; p++)
        for (var e = 0; e < 2; e++) { var t = names[plats[p] + "_" + e + "_" + id]; if (t) return t; }
      return null;
    }
    return {
      raw: names,
      family: pick(16, [3, 1]) || pick(1, [3, 1]),
      style: pick(17, [3, 1]) || pick(2, [3, 1]),
      full: pick(4, [3, 1]),
      postscript: pick(6, [3, 1])
    };
  }

  // ---- cmap table (format 4 + 12) --------------------------------------
  function parseCmap(r, base) {
    var out = { preferred: null };
    var num = r.u16(base + 2) || 0;
    var best12 = null, best4 = null;
    for (var i = 0; i < num; i++) {
      var rec = base + 4 + i * 8;
      var soff = r.u32(rec + 4);
      if (!soff) continue;
      var sOff = base + soff;
      var fmt = r.u16(sOff);
      if (fmt === 12) {
        var groups = r.u32(sOff + 12) || 0;
        var g = [];
        for (var k = 0; k < groups; k++) {
          var go = sOff + 16 + k * 12;
          if (r.u32(go) === null) break;
          g.push({ s: r.u32(go), e: r.u32(go + 4), g0: r.u32(go + 8) });
        }
        if (g.length && (!best12 || g.length > best12.length)) best12 = g;
      } else if (fmt === 4) {
        var segX2 = r.u16(sOff + 6) || 0;
        var seg = segX2 >> 1;
        var endCodes = [], startCodes = [], deltas = [], rangeOffs = [];
        for (var s = 0; s < seg; s++) endCodes.push(r.u16(sOff + 14 + s * 2));
        var idDeltaBase = sOff + 14 + segX2 + 2;
        for (var s2 = 0; s2 < seg; s2++) startCodes.push(r.u16(idDeltaBase + s2 * 2));
        var idRangeBase = idDeltaBase + segX2;
        for (var s3 = 0; s3 < seg; s3++) deltas.push(r.i16(idRangeBase + s3 * 2));
        for (var s4 = 0; s4 < seg; s4++) rangeOffs.push(r.u16(idRangeBase + segX2 + s4 * 2));
        best4 = { seg: seg, endCodes: endCodes, startCodes: startCodes,
          deltas: deltas, rangeOffs: rangeOffs, idRangeOffBase: idRangeBase + segX2, sOff: sOff, r: r };
      }
    }
    if (best12) { out.format12 = best12; out.preferred = "12"; }
    if (best4 && !best12) out.preferred = "4";
    if (best4) out.format4 = best4;
    return out;
  }

  function cmap4(map, code) {
    var m = map;
    // endCodes is monotonically non-decreasing -> binary search for the
    // highest segment whose endCode >= code.
    var lo = 0, hi = m.seg - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (m.endCodes[mid] < code) lo = mid + 1;
      else hi = mid - 1;
    }
    var i = lo;
    if (i >= m.seg || code < m.startCodes[i] || code > m.endCodes[i]) return 0;
    var delta = m.deltas[i], rOff = m.rangeOffs[i];
    if (rOff === 0) return (code + delta) & 0xFFFF;
    var idx = rOff / 2 + (code - m.startCodes[i]) - i;
    var p = m.idRangeOffBase + idx * 2;
    var v = m.r.u16(p);
    return v === null ? 0 : (v === 0 ? 0 : (v + delta) & 0xFFFF);
  }

  function cmap12(groups, code) {
    var lo = 0, hi = groups.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1, g = groups[mid];
      if (g.s <= code) { if (g.e >= code) return g.g0 + (code - g.s); lo = mid + 1; }
      else hi = mid - 1;
    }
    return 0;
  }

  // ---- post table (glyph names) ----------------------------------------
  function parsePost(r, base) {
    var version = r.fixed(base);
    if (version === null) return { names: null };
    var major = version >>> 16;
    var o = { major: major, names: null };
    // format 2.0: 32-byte header, then numberOfGlyphs (u16), then per-glyph
    // 16-bit AGL indices, then a length-prefixed pool of custom names.
    if (major === 2) {
      var count = r.u16(base + 32);
      var p = base + 34;
      var names = [];
      if (count !== null && p + count * 2 <= r.len) {
        for (var i = 0; i < count; i++) {
          var idx = r.u16(p); p += 2;
          if (idx < 258) names.push(AGL[idx]);
          else if (idx === 258) names.push(null);        // no name
          else {
            var c = idx - 258;
            var nlen = r.u8(p); p += 1;
            if (nlen === null || p + nlen > r.len) break;
            var nm = "";
            for (var b = 0; b < nlen; b++) nm += String.fromCharCode(r.u8(p + b));
            names.push(nm); p += nlen;
          }
        }
      }
      o.names = names;
    }
    return o;
  }

  // ---- OS/2 table (verified offsets, bounds-safe) ----------------------
  // OS/2 of a standard font is v1, 86 bytes long. Offsets relative to the start:
  //   usWeightClass@4  usWidthClass@6  sTypoAscender@68  sTypoDescender@70
  //   sTypoLineGap@72  usWinAscent@74  usWinDescent@76  sXHeight@78  sCapHeight@80
  // (an earlier revision read the metrics at 52/54/56 and 72/74/76/78 — 16 bytes
  //  early — which silently returned 0/0/0 and broke the big-view placement)
  function parseOS2(r, base, len) {
    var u16 = function (off) { return off + 2 <= len ? r.u16(base + off) : null; };
    var i16 = function (off) { return off + 2 <= len ? r.i16(base + off) : null; };
    var o = { version: u16(0) };
    o.usWeightClass = u16(4);
    o.usWidthClass = u16(6);
    if (len >= 70) {
      o.sTypoAscender = i16(68);
      o.sTypoDescender = i16(70);
      o.sTypoLineGap = i16(72);
    }
    if (len >= 80) {
      o.usWinAscent = u16(74);
      o.usWinDescent = u16(76);
      o.sXHeight = i16(78);
      o.sCapHeight = i16(80);
    }
    return o;
  }

  // ---- hmtx (advance widths) -------------------------------------------
  function parseHmtx(r, base, numGlyphs, numberOfHMetrics) {
    var out = [];
    if (numberOfHMetrics === null || numberOfHMetrics <= 0) return out;
    for (var i = 0; i < numberOfHMetrics; i++) {
      var a = r.u16(base + i * 4);
      out.push(a === null ? 0 : a);
    }
    var last = out[numberOfHMetrics - 1] || 0;
    for (var j = numberOfHMetrics; j < numGlyphs; j++) out.push(last);
    return out;
  }

  // ---- public: load an ArrayBuffer -> Font object -----------------------
  function load(buffer) {
    var f = { ok: false, size: buffer.byteLength, warnings: [] };
    try {
      var r = Reader(buffer);
      if (buffer.byteLength < 12) throw new Error("file too small");
      var sfnt = r.tag(0);
      if (sfnt === "OTTO") f.flavor = "OpenType (CFF)";
      else if (sfnt === "true" || sfnt === "ttcf") f.flavor = "TrueType";
      else if (sfnt === "wOFF") f.flavor = "WOFF";
      else if (sfnt === "wOF2") f.flavor = "WOFF2";
      else if (r.u32(0) === 0x00010000) f.flavor = "TrueType";
      else f.flavor = "unknown";

      f.numGlyphs = 0;
      var numTables = r.u16(4) || 0;
      var tables = {};
      for (var i = 0; i < numTables; i++) {
        var off = 12 + i * 16;
        var tag = r.tag(off);
        if (!tag) break;
        tables[tag] = { offset: r.u32(off + 8) || 0, length: r.u32(off + 12) || 0 };
      }

      // head / maxp
      if (tables.head) { var h = tables.head.offset; f.unitsPerEm = r.u16(h + 18); }
      if (tables.maxp) { f.numGlyphs = r.u16(tables.maxp.offset + 4) || 0; }
      f.unitsPerEm = f.unitsPerEm || 1000;

      // name (safe)
      try { if (tables.name) f.name = parseName(r, tables.name.offset); } catch (e) { f.warnings.push("name: " + e); }

      // cmap
      if (tables.cmap) {
        try {
          f.cmap = parseCmap(r, tables.cmap.offset);
          var cmapResolver = function (code) {
            if (f.cmap && f.cmap.format12) {
              var g = cmap12(f.cmap.format12, code);
              if (g) return g;
            }
            if (f.cmap && f.cmap.format4) return cmap4(f.cmap.format4, code);
            return 0;
          };
          // Self-check: in a well-formed cmap each glyph id is mapped by at
          // most one codepoint. Some hand-edited files (the Peptasia sample
          // included) carry a format-4 subtable that maps the same glyph id
          // to many different codepoints and leaves gaps. When that happens,
          // fall back to the vendored opentype.js (its cmap read is the one
          // that matches the font's own glyph names) and flag it.
          var cmapBad = false;
          if (cmapResolver && (f.cmap.format12 || f.cmap.format4)) {
            var seen = new Array(f.numGlyphs || 0);
            var scanEnd = f.cmap.format12 ? 0x110000 : 0x10000;
            for (var code = 0; code < scanEnd; code++) {
              var gid = cmapResolver(code);
              if (gid > 0) {
                if (seen[gid]) { cmapBad = true; break; }
                seen[gid] = true;
              }
            }
            if (cmapBad) f.warnings.push("cmap: glyph ids are mapped more than once (hand-edited file); using the secondary reader for this table");
          }
          f.cmapGlyph = cmapResolver;
          if (cmapBad && typeof globalThis !== "undefined" && globalThis.opentype && f.numGlyphs < 0x8000) {
            try {
              var of2 = globalThis.opentype.parse(buffer);
              var om = of2.tables && of2.tables.cmap && of2.tables.cmap.glyphIndexMap;
              if (om) {
                f.cmap2 = om; // codepoint -> glyph id (the trusted read)
                f.ot2 = of2;  // keep the secondary parse for glyph names too
                f.cmapGlyph = function (code) {
                  var g = om[code];
                  return (g > 0 && g < f.numGlyphs) ? g : 0;
                };
              }
            } catch (e2) { /* keep the first read */ }
          }
        } catch (e) { f.warnings.push("cmap: " + e); }
      }
      if (!f.cmapGlyph) f.cmapGlyph = function () { return 0; };

      // hmtx (safe; number of advance widths = numGlyphs, but bound by the
      // real table length so we never read past it)
      try {
        if (tables.hmtx && f.numGlyphs) {
          var hmtxRows = Math.min(f.numGlyphs, tables.hmtx.length >> 2);
          var hmtx = parseHmtx(r, tables.hmtx.offset, f.numGlyphs, hmtxRows);
          if (hmtx.length) f.advances = hmtx;
        }
      } catch (e) { f.warnings.push("hmtx: " + e); }

      // post (safe)
      try { if (tables.post) f.post = parsePost(r, tables.post.offset); } catch (e) { f.warnings.push("post: " + e); }

      // OS/2 (safe, verified offsets): weight/width for the status bar and
      // typo ascender/descender for the metric guides in the big view.
      try {
        if (tables["OS/2"] && tables["OS/2"].length >= 60) f.os2 = parseOS2(r, tables["OS/2"].offset, tables["OS/2"].length);
      } catch (e) { f.warnings.push("os2: " + e); }

      // CFF outlines (for OTF fonts): parse lazily-safe; kept for SVG export.
      try {
        if (tables["CFF "] && (f.flavor === "OpenType (CFF)")) f.cff = parseCFF(r, tables["CFF "].offset, tables["CFF "].length);
      } catch (e) { f.warnings.push("cff: " + e); }

      // outline(gid) -> array of path ops (M/L/C/Z, font units, y-up) or null
      f.outline = function (gid) {
        if (gid == null || gid <= 0 || gid >= (f.numGlyphs || 1)) return null;
        try {
          if (tables.glyf && tables.loca && tables.head) return glyfOps(r, tables, gid, f, 0);
          if (f.cff) return cffOps(r, f.cff, gid, 0);
        } catch (e) { /* fall through */ }
        return null;
      };

      f.glyphName = function (gid) {
        var post = f.post;
        if (post && post.names && post.names[gid]) return post.names[gid];
        if (AGL[gid]) return AGL[gid];
        return "glyph_" + gid;
      };
      // When the cmap self-check failed we fell back to the secondary
      // reader; its CFF-derived glyph names are the right ones too (the hand
      // post-table read is scrambled on these hand-edited CFF files).
      if (f.cmap2 && f.ot2) {
        var otNames = f.ot2.glyphs;
        var handName = f.glyphName;
        f.glyphName = function (gid) {
          try {
            var g = otNames.get(gid);
            if (g && g.name) return g.name;
          } catch (eN) { /* fall through */ }
          return handName(gid);
        };
      }

      f.defined = buildDefined(f);
      f.ok = true;
    } catch (e) {
      f.ok = false;
      f.errors = String(e && e.message || e);
    }
    return f;
  }

  function buildDefined(f) {
    var defined = [];
    // A validated fallback cmap (f.cmap2: codepoint -> gid, from the
    // secondary reader) takes precedence: on hand-edited files the raw hand
    // read is scrambled, so the trusted read is the one that's right.
    if (f.cmap2) {
      var keys = Object.keys(f.cmap2);
      for (var i = 0; i < keys.length; i++) {
        var c2 = +keys[i];
        if (c2 > 0 && c2 <= 0x10FFFF && f.cmap2[c2] > 0) defined.push(c2);
      }
      defined.sort(function (a, b) { return a - b; });
      return defined;
    }
    if (!f.cmap) return defined;
    var MAXSPAN = 600000;
    if (f.cmap.format12) {
      var g = f.cmap.format12;
      for (var i = 0; i < g.length; i++) {
        var start = g[i].s, end = g[i].e, span = end - start + 1;
        var step = span > MAXSPAN ? Math.ceil(span / MAXSPAN) : 1;
        for (var c = start; c <= end; c += step) {
          if (c < 0 || c > 0x10FFFF) continue;
          var gid = g[i].g0 + (c - start);
          if (gid > 0) defined.push(c);
        }
      }
    } else if (f.cmap.format4) {
      var m = f.cmap.format4;
      for (var code = m.startCodes[0]; code <= m.endCodes[m.seg - 1]; code++) {
        if (cmap4(m, code) > 0) defined.push(code);
      }
    }
    return defined;
  }

  // ---- TrueType outline decoding (glyf + loca) -------------------------
  // Returns a list of path ops (M / L / C / Z) in font units (y up), with
  // composite glyphs flattened. Each op: ['M',x,y] | ['L',x,y] | ['C',x1,y1,x2,y2,x,y] | ['Z'].
  function glyfOps(r, tables, gid, f, depth) {
    depth = depth || 0;
    if (depth > 24) return [];
    var glyf = tables.glyf.offset, loca = tables.loca.offset;
    var head = tables.head.offset;
    var longLoca = (r.u16(head + 50) === 1);
    function loff(g) { return longLoca ? (r.u32(loca + g * 4) || 0) : (r.u16(loca + g * 2) || 0) * 2; }
    var s = loff(gid), e = loff(gid + 1);
    if (!s || s >= e) return [];

    function quadToCubic(p0, c, p1) {
      return [
        p0.x + (2 / 3) * (c.x - p0.x), p0.y + (2 / 3) * (c.y - p0.y),
        p1.x + (2 / 3) * (c.x - p1.x), p1.y + (2 / 3) * (c.y - p1.y),
        p1.x, p1.y
      ];
    }
    function opsFromContour(pts) {
      var ops = [];
      if (pts.length < 2) return ops;
      // rotate so the first point is an on-curve point
      var i0 = 0;
      while (i0 < pts.length && !pts[i0].on) i0++;
      if (i0 >= pts.length) return ops;
      var start = pts[i0];
      ops.push(["M", start.x, start.y]);
      var offs = [];
      for (var k = 1; k <= pts.length; k++) {
        var idx = (i0 + k) % pts.length;
        var p = pts[idx];
        if (p.on) {
          if (offs.length === 0) ops.push(["L", p.x, p.y]);
          else if (offs.length === 1) ops.push(["C"].concat(quadToCubic(start, offs[0], p)));
          else if (offs.length === 2) {
            var m1 = quadToCubic(start, offs[0], offs[1]);
            var m2 = quadToCubic(offs[1], offs[1], p);
            var cx = (m1[4] + m2[1]) / 2, cy = (m1[5] + m2[2]) / 2;
            ops.push(["C", m1[0], m1[1], cx, cy, m1[4], m1[5]]);
            ops.push(["C", m2[1], m2[2], m2[3], m2[4], m2[5]]);
          } else {
            // 3+ off-curves between on-curves: treat as chained quadratics
            for (var q = 0; q < offs.length; q++) {
              var np = (q === offs.length - 1) ? p : offs[q + 1];
              var c1 = (q === 0) ? start : offs[q - 1];
              var c2 = offs[q];
              ops.push(["C"].concat(quadToCubic(c1, c2, np)));
            }
          }
          offs = [];
          start = p;
        } else offs.push(p);
      }
      ops.push(["Z"]);
      return ops;
    }

    var base = glyf + s;
    var nContours = r.i16(base);
    if (nContours === null) return [];

    if (nContours >= 0) {
      // simple glyph
      var endPts = [];
      for (var i = 0; i < nContours; i++) endPts.push(r.u16(base + 10 + i * 2));
      var nPts = (endPts.length ? endPts[endPts.length - 1] + 1 : 0);
      var instLen = r.u8(base + 10 + nContours * 2);
      var p = base + 10 + nContours * 2 + 1 + (instLen || 0);
      var flags = [];
      var pt = 0;
      while (pt < nPts) {
        var flag = r.u8(p); p++;
        if (flag === null) break;
        flags.push(flag); pt++;
        if (flag & 0x08) {  // repeatNext
          var rep = r.u8(p); p++;
          for (var rr = 0; rr < rep; rr++) { flags.push(flag); pt++; }
        }
      }
      // x coords: bit 0x02 = 1-byte signed delta; bit 0x04 = "same as previous"
      // (no bytes); otherwise a 2-byte 16-bit absolute value (big-endian) — it
      // must be READ, not skipped.
      var xs = [], prev = 0;
      for (var xi = 0; xi < flags.length; xi++) {
        var f1 = flags[xi];
        if (f1 & 0x02) { var d1 = r.i8(p); if (d1 == null) break; p++; prev += d1; }
        else if (!(f1 & 0x04)) { var v1 = r.i16(p); if (v1 == null) break; p += 2; prev = v1; }
        xs.push(prev);
      }
      // y coords: bit 0x10 = 1-byte signed delta; bit 0x20 = "same as previous"
      // (no bytes); otherwise a 2-byte 16-bit absolute value (must be read).
      var ys = [], prevY = 0;
      for (var yi = 0; yi < flags.length; yi++) {
        var f2 = flags[yi];
        if (f2 & 0x10) { var dy1 = r.i8(p); if (dy1 == null) break; p++; prevY += dy1; }
        else if (!(f2 & 0x20)) { var vy1 = r.i16(p); if (vy1 == null) break; p += 2; prevY = vy1; }
        ys.push(prevY);
      }
      var contours = [];
      var c0 = 0;
      for (var ci = 0; ci < nContours; ci++) {
        var c1 = endPts[ci] + 1;
        var cp = [];
        for (var pi = c0; pi < c1; pi++) cp.push({ x: xs[pi] || 0, y: ys[pi] || 0, on: !!(flags[pi] & 0x01) });
        contours.push(cp); c0 = c1;
      }
      var ops = [];
      for (var cc = 0; cc < contours.length; cc++) ops = ops.concat(opsFromContour(contours[cc]));
      return ops;
    }

    // composite glyph
    var comps = [];
    var cbase = base + 2;
    var cflags = r.u16(cbase);
    cbase += 2;
    while (true) {
      var fgc = (cflags != null ? cflags : 0);
      var cgid;
      if (fgc & 0x20) cgid = r.u8(cbase); else cgid = r.u16(cbase);
      if (cgid == null) break;
      cbase += (fgc & 0x20) ? 1 : 2;
      var x, y, sx = 1, sy = 1, a = 1, b = 0, c = 0, d = 1, hasXf = false;
      if (fgc & 0x40) { x = r.u16(cbase); y = r.u16(cbase + 2); cbase += 4; }
      else { x = r.i8(cbase); y = r.i8(cbase + 1); cbase += 2; }
      if (fgc & 0x08) { a = r.fixed(cbase); b = r.fixed(cbase + 4); c = r.fixed(cbase + 8); d = r.fixed(cbase + 12); cbase += 16; hasXf = true; }
      else if (fgc & 0x04) { a = r.fixed(cbase); d = r.fixed(cbase + 4); cbase += 8; hasXf = true; }
      else if (fgc & 0x02) { sx = r.fixed(cbase); sy = sx; cbase += 4; }
      // 16.16 fixed-point: divide by 65536 to get the real scale/matrix.
      a = a / 65536; b = b / 65536; c = c / 65536; d = d / 65536;
      if (!hasXf) { sx = sx / 65536; sy = sx; a = sx; d = sx; b = c = 0; }
      comps.push({ gid: cgid, a: a, b: b, c: c, d: d, x: x, y: y });
      if (!(fgc & 0x01)) break;
      cflags = r.u16(cbase); cbase += 2;
    }
    var all = [];
    for (var k2 = 0; k2 < comps.length; k2++) {
      var cm = comps[k2];
      var sub = glyfOps(r, tables, cm.gid, f, depth + 1);
      for (var oi = 0; oi < sub.length; oi++) {
        var op = sub[oi];
        var out = [op[0]];
        for (var vi = 1; vi < op.length; vi += 2) {
          var nx = cm.a * op[vi] + cm.c * op[vi + 1] + cm.x;
          var ny = cm.b * op[vi] + cm.d * op[vi + 1] + cm.y;
          out.push(nx, ny);
        }
        all.push(out);
      }
    }
    return all;
  }

  // ---- CFF (Type 2 charstring) outline decoding ------------------------
  function readCFFIndex(r, p) {
    var count = r.u16(p);
    if (!count) return { count: 0, data: [], end: p + 2 };
    var offSize = r.u8(p + 2);
    var offsStart = p + 3;
    function readOff(o) {
      if (offSize === 1) return r.u8(o);
      if (offSize === 2) return r.u16(o);
      if (offSize === 3) return (r.u8(o) << 16) | r.u16(o + 1);
      return r.u32(o);
    }
    var off = [];
    for (var i = 0; i <= count; i++) off.push(readOff(offsStart + i * offSize));
    var dataStart = offsStart + (count + 1) * offSize;
    var data = [];
    for (var j = 0; j < count; j++) data.push([dataStart + off[j] - 1, dataStart + off[j + 1] - 1]);
    return { count: count, ranges: data, end: dataStart + off[count] - 1 };
  }

  function parseCFFDict(r, base, length) {
    var fields = {}, stack = [], i = base, end = base + length;
    // number of stack values each CFF top-dict operator consumes
    var CFF_POPS = { 1: 0, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1,
      10: 0, 11: 0, 12: 0, 13: 0, 14: 0, 15: 0, 16: 0,
      17: 1, 18: 1, 19: 1, 20: 2, 21: 0, 22: 0,
      23: 1, 24: 1, 25: 1, 26: 1, 27: 1,
      28: 1, 29: 2, 30: 1, 31: 1 };
    while (i < end) {
      var b = r.u8(i);
      if (b == null) break;
      i++;
      if (b === 28) { stack.push(r.u8(i) || 0); i++; }
      else if (b === 29) { stack.push(r.i16(i) || 0); i += 2; }
      else if (b < 32) {
        var pops = CFF_POPS[b] || 0;
        var vals = [];
        for (var k = 0; k < pops; k++) vals.unshift(stack.length ? stack.pop() : 0);
        if (pops) fields[b] = vals;
      }
      else if (b >= 32 && b <= 246) {
        stack.push(b <= 110 ? b - 132 : (b > 112 ? b - 132 : 0));
      }
      else if (b >= 247 && b <= 250) { var nb = r.u8(i); i++; stack.push(256 * (b - 247) + (nb - 108)); }
      else if (b >= 251 && b <= 254) {
        var n2 = r.u8(i); i++;
        var key2 = ((b - 250) << 8) | n2;
        var v2 = stack.length ? stack.pop() : 0;
        fields[key2] = [v2];
      }
      else if (b === 255) { i += 2; }
      else stack.push(0);
    }
    return fields;
  }

  function parseCFF(r, base, len) {
    var hdr = r.u8(base + 2);
    var pos = base + hdr;
    var nameIdx = readCFFIndex(r, pos);
    var topIdx = readCFFIndex(r, nameIdx.end);
    var strIdx = readCFFIndex(r, topIdx.end);
    var gsubIdx = readCFFIndex(r, strIdx.end);
    if (!topIdx.count || !topIdx.ranges[0]) return null;
    var topData = [topIdx.ranges[0][0], topIdx.ranges[0][1]];
    var topLen = topData[1] - topData[0];
    var top = parseCFFDict(r, topData[0], topLen);
    function field(k) { return (top[k] && top[k][0] != null) ? top[k][0] : null; }
    var charStrOff = field(17) != null ? (field(17) >>> 0) : null;
    if (charStrOff == null || charStrOff <= 0) return null;
    var cffIndex = readCFFIndex(r, base + charStrOff);
    // private dict -> subrs
    var privOff = field(18) != null ? field(18) : null;
    var subrs = [];
    if (privOff != null && privOff > 0) {
      var pRange = cffIndex.ranges[0] ? cffIndex.ranges[0] : null;
      var priv = parseCFFDict(r, base + privOff, 512);
      var subOff = (priv[19] && priv[19][0] != null) ? priv[19][0] : null;
      if (subOff != null && subOff > 0) subrs = readCFFIndex(r, base + charStrOff + subOff);
    }
    return {
      charStrings: cffIndex,
      globalSubrs: gsubIdx,
      localSubrs: subrs
    };
  }

  // Correct, compact Type 2 charstring interpreter.
  // Path operators (Type 2 set, 0..31 plus 12 escape):
  //   15 hmoveto(1)  17 rmoveto(2)  18 hline(1)  19 vline(1)  20 rlineto(2)
  //   21 hlineto(1)  22 vlineto(1)  23 rrcurveto(6)  24 rcurveto(6)
  //   25 vhcurveto   26 hvcurveto   27 rcurveline(8) 28 rlinecurve(8)
  //   29 vhcurveline 30 hvcurveline 31 rrcurveline(10)
  //   10 callgsubr(1) 11 callsubr(1) 12 escape 13 return 14 endchar
  // Hint operators (0-9,16 + escape 8,9) pop operands but don't draw.
  function cffOps(r, cff, gid, depth) {
    depth = depth || 0;
    var cs = cff.charStrings;
    if (gid < 0 || gid >= cs.count || !cs.ranges[gid]) return [];
    var data = cs.ranges[gid];
    var bytes = [];
    for (var i = data[0]; i < data[1]; i++) bytes.push(r.u8(i) != null ? r.u8(i) : 0);
    if (!bytes.length) return [];

    // optional width prefix (0 or 1 number at the start)
    var first = bytes[0];
    var start = 0;
    if (first >= 32 && first <= 246) start = 1;
    else if (first >= 247 && first <= 255) start = 2;

    var ops = [];
    var popN = [2, 2, 4, 4, 4, 2, 4, 4, 2, 2, 1, 1, 0, 0, 0, 1, 2, 2, 1, 1, 2, 1, 1, 6, 6, 0, 0, 8, 8, 0, 0, 10];

    function push(o) { ops.push(o); }
    function exec(prog, base, depth) {
      if (depth > 40) return;
      var pi = 0, len = prog.length;
      var stack = [];
      var x = 0, y = 0;
      function pop() { return stack.length ? stack.pop() : 0; }
      function num() {
        var b = prog[pi];
        if (b >= 32 && b <= 110) { pi++; return b - 132; }
        if (b >= 121 && b <= 246) { pi++; return b + 132; }
        if (b >= 247 && b <= 250) { pi += 2; return 256 * (b - 247) + (prog[pi - 1] - 108); }
        if (b >= 251 && b <= 254) { pi += 2; return 256 * (b - 251) + (prog[pi - 1] + 108); }
        if (b === 255) { pi += 2; var v = (prog[pi - 2] << 8) | prog[pi - 1]; return v > 0x7fff ? v - 0x10000 : v; }
        pi++; return 0;
      }
      function subrCall(kind) {
        var idx = pop();
        var sub = (kind === 10) ? cff.globalSubrs : cff.localSubrs;
        if (sub && sub.count && sub.ranges[idx]) {
          var sb = [];
          for (var si = sub.ranges[idx][0]; si < sub.ranges[idx][1]; si++) sb.push(r.u8(si) != null ? r.u8(si) : 0);
          exec(sb, base, depth + 1);
        }
      }
      function flagCurve(flagsByte, n, isLast, mode) {
        // mode 0 = vh (25), 1 = hv (26)
      }
      while (pi < len) {
        var b = prog[pi];
        if (b >= 32 && b <= 255) { stack.push(num()); continue; }
        pi++;
        if (b === 14) return;          // endchar
        if (b === 13) return;          // return
        if (b === 10) { subrCall(10); continue; }
        if (b === 11) { subrCall(11); continue; }
        if (b === 12) {
          var esc = prog[pi]; pi++;
          if (esc === 6) { var ex = pop(), ey = pop(); x += ex / 1000; y += ey / 1000; push(["M", x, y]); }
          else if (esc === 7) { var ex2 = pop(); x = ex2 / 1000; y = 0; push(["M", x, y]); }
          else if (esc === 4) { pop(); pop(); pop(); pop(); pop(); }      // seac (skip)
          else if (esc === 5) { pop(); pop(); }
          else if (esc === 8) { pop(); pop(); }
          else if (esc === 9) { pop(); pop(); pop(); pop(); }
          else if (esc === 10) { pop(); }
          else if (esc === 1) { pop(); pop(); }
          else if (esc === 2) { pop(); pop(); }
          else if (esc === 3) { }
          else if (esc === 11) { }
          continue;
        }
        switch (b) {
          case 15: { var vx = pop(); x = vx / 1000; y = 0; push(["M", x, y]); break; }
          case 17: { var rx = pop(), ry = pop(); x += rx / 1000; y += ry / 1000; push(["M", x, y]); break; }
          case 18: { var hx = pop(); x += hx / 1000; push(["L", x, y]); break; }
          case 19: { var vy = pop(); y += vy / 1000; push(["L", x, y]); break; }
          case 20: { var dxx = pop(), dyy = pop(); x += dxx / 1000; y += dyy / 1000; push(["L", x, y]); break; }
          case 21: { var hxx = pop(); x += hxx / 1000; push(["L", x, y]); break; }
          case 22: { var vyy = pop(); y += vyy / 1000; push(["L", x, y]); break; }
          case 23: case 24: { // rrcurveto / rcurveto (6 numbers)
            var c1x = x, c1y = y;
            for (var q = 0; q < 3; q++) {
              var ax = pop() / 1000, ay = pop() / 1000;
              var bx = pop() / 1000, by = pop() / 1000;
              var ex = pop() / 1000, ey = pop() / 1000;
              var p1x = c1x + ax, p1y = c1y + ay, p2x = bx + ex, p2y = by + ey;
              c1x += ex; c1y += ey;
              push(["C", p1x, p1y, p2x, p2y, c1x, c1y]);
            }
            x = c1x; y = c1y;
            break;
          }
          case 27: { // rcurveline: 6 curve numbers + 2 line numbers
            var c2x = x, c2y = y;
            for (var q2 = 0; q2 < 3; q2++) {
              var a2 = pop() / 1000, b2 = pop() / 1000;
              var c2 = pop() / 1000, d2 = pop() / 1000;
              var e2 = pop() / 1000, f2 = pop() / 1000;
              var q1x = c2x + a2, q1y = c2y + b2, q2x = c2 + e2, q2y = d2 + f2;
              c2x += e2; c2y += f2;
              push(["C", q1x, q1y, q2x, q2y, c2x, c2y]);
            }
            x = c2x; y = c2y;
            var lxx = pop() / 1000, lyy = pop() / 1000;
            x += lxx; y += lyy; push(["L", x, y]);
            break;
          }
          case 28: { // rlinecurve: 2 line numbers + 6 curve numbers
            var l2x = pop() / 1000, l2y = pop() / 1000;
            x += l2x; y += l2y; push(["L", x, y]);
            var c3x = x, c3y = y;
            for (var q3 = 0; q3 < 3; q3++) {
              var a3 = pop() / 1000, b3 = pop() / 1000;
              var c3 = pop() / 1000, d3 = pop() / 1000;
              var e3 = pop() / 1000, f3 = pop() / 1000;
              var r1x = c3x + a3, r1y = c3y + b3, r2x = c3 + e3, r2y = d3 + f3;
              c3x += e3; c3y += f3;
              push(["C", r1x, r1y, r2x, r2y, c3x, c3y]);
            }
            x = c3x; y = c3y;
            break;
          }
          case 31: { // rrcurveline: 10 numbers
            var c4x = x, c4y = y;
            for (var q4 = 0; q4 < 3; q4++) {
              var a4 = pop() / 1000, b4 = pop() / 1000;
              var c4 = pop() / 1000, d4 = pop() / 1000;
              var e4 = pop() / 1000, f4 = pop() / 1000;
              var s1x = c4x + a4, s1y = c4y + b4, s2x = c4 + e4, s2y = d4 + f4;
              c4x += e4; c4y += f4;
              push(["C", s1x, s1y, s2x, s2y, c4x, c4y]);
            }
            x = c4x; y = c4y;
            var l3x = pop() / 1000, l3y = pop() / 1000;
            x += l3x; y += l3y; push(["L", x, y]);
            break;
          }
          case 25: case 26: case 29: case 30: { // flag-based curveto ops
            var fb = prog[pi]; pi++;
            var nc = (fb >> 4) || 15;
            var fl = fb & 0x0F;
            var vh = (b === 25 || b === 29); // first delta axis
            var cx = x, cy = y;
            for (var cq = 0; cq < nc; cq++) {
              var flag = (nc <= 4) ? ((fl >> (nc - 1 - cq)) & 1) : ((fl >> (cq & 3)) & 1);
              var ax, ay, bx, by, ex, ey;
              // first delta: axis flips with the vh/hv choice
              if (vh) { if (flag) { ax = pop() / 1000; ay = 0; } else { ay = pop() / 1000; ax = 0; } }
              else { if (flag) { ay = pop() / 1000; ax = 0; } else { ax = pop() / 1000; ay = 0; } }
              bx = pop() / 1000; by = pop() / 1000;
              // last delta of the last curve
              if (cq === nc - 1) {
                if (vh) { ex = pop() / 1000; ey = 0; } else { ey = pop() / 1000; ex = 0; }
              } else {
                if (vh) { ey = pop() / 1000; ex = 0; } else { ex = pop() / 1000; ey = 0; }
              }
              var t1x = cx + ax, t1y = cy + ay, t2x = bx + ex, t2y = by + ey;
              cx += ex; cy += ey;
              push(["C", t1x, t1y, t2x, t2y, cx, cy]);
            }
            x = cx; y = cy;
            break;
          }
          default: { // hints
            var pn = popN[b] || 0;
            for (var h = 0; h < pn; h++) pop();
            break;
          }
        }
        if (ops.length > 200000) return;
      }
    }
    exec(bytes, 0, depth);
    return ops;
  }

  function opsBbox(ops) {
    var xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (var i = 1; i < ops.length; i += 1) {
      var o = ops[i];
      var n = o.length;
      for (var v = 1; v < n; v += 2) {
        if (o[v] < xMin) xMin = o[v];
        if (o[v] > xMax) xMax = o[v];
        if (o[v + 1] < yMin) yMin = o[v + 1];
        if (o[v + 1] > yMax) yMax = o[v + 1];
      }
    }
    if (xMin === Infinity) return null;
    return { xMin: xMin, xMax: xMax, yMin: yMin, yMax: yMax };
  }

  global.FontParser = { load: load, AGL: AGL, glyfOps: glyfOps, cffOps: cffOps, opsBbox: opsBbox, parseCFF: parseCFF };
})(typeof window !== "undefined" ? window : globalThis);
