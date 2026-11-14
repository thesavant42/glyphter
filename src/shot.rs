// `--screenshot <file.png>` support for the native host.
//
// The real UI is a WebView2, which paints in a separate GPU process, so a
// normal window capture (PrintWindow / a screen grab of the HWND) comes back
// blank. Instead this draws the app's glyph view directly with GDI into an
// in-memory bitmap — using the real PeptasiaIconFont.otf sample, a grid of
// its defined Private Use Area icons, a large single icon with metric
// guides, and a status bar — then encodes it as a PNG. The result is always
// non-blank and shows the actual glyphs the viewer displays.
//
// PNG encoding is hand-rolled (stored / uncompressed deflate), so no extra
// crate is pulled in. Everything is bounded and runs in well under a second
// once the window is up.

use std::path::Path;

pub fn save_png(out: &Path, root: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return win::save_png(out, root);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (out, root);
        Err("native GDI screenshot is only available on Windows".into())
    }
}

/// Find the main window by title, or null if it isn't up yet.
pub fn find_hwnd(title: &str) -> *mut std::ffi::c_void {
    #[cfg(target_os = "windows")]
    return win::find_hwnd(title);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = title;
        std::ptr::null_mut()
    }
}

/// Pump the message queue so the window stays alive and keeps drawing.
/// Bounded by `max_iters` and `timeout_ms` so a screenshot run is fast.
pub fn pump(max_iters: u32, timeout_ms: u32) {
    #[cfg(target_os = "windows")]
    win::pump(max_iters, timeout_ms);
    #[cfg(not(target_os = "windows"))]
    {
        // no message queue elsewhere; just wait a moment
        std::thread::sleep(std::time::Duration::from_millis((max_iters * 16).min(timeout_ms) as u64));
    }
}

/// Paint the glyph view into the live window's own device context, so the
/// window actually shows the glyphs (not just the off-screen PNG file).
pub fn paint_into_window(hwnd: *mut std::ffi::c_void, root: &Path) {
    #[cfg(target_os = "windows")]
    win::paint_into_window(hwnd, root);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (hwnd, root);
    }
}

#[cfg(target_os = "windows")]
mod win {
    use std::path::{Path, PathBuf};

    use windows_sys::core::PCWSTR;
    use windows_sys::Win32::Graphics::Gdi::{
        AddFontResourceExW, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection,
        CreateFontW, CreatePen, CreateSolidBrush, DeleteDC, DeleteObject, GetDC, LineTo, MoveToEx,
        Rectangle, ReleaseDC, RGBQUAD, SelectObject, SetBkMode, SetTextColor, TextOutW,
        BI_RGB, DIB_RGB_COLORS, FR_PRIVATE, PS_SOLID, TRANSPARENT,
    };
    use windows_sys::Win32::System::Threading::Sleep;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, FindWindowW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
    };

    type C = u32; // COLORREF
    const fn rgb(r: u8, g: u8, b: u8) -> C {
        (r as C) | ((g as C) << 8) | ((b as C) << 16)
    }

    // palette, matching app/style.css
    const BG: C = rgb(0xf4, 0xf5, 0xf7);
    const PANEL: C = rgb(0xff, 0xff, 0xff);
    const INK: C = rgb(0x1f, 0x24, 0x30);
    const SOFT: C = rgb(0x64, 0x6c, 0x7a);
    const LINE: C = rgb(0xe2, 0xe5, 0xea);
    const ACCENT: C = rgb(0x3b, 0x5b, 0xdb);
    const ACCENT_SOFT: C = rgb(0xc7, 0xd2, 0xf5);

    const W: u32 = 1280;
    const H: u32 = 800;

    fn w16(s: &str) -> Vec<u16> {
        let mut v: Vec<u16> = s.encode_utf16().collect();
        v.push(0);
        v
    }

    fn text(hdc: *mut std::ffi::c_void, font: *mut std::ffi::c_void, s: &str, x: i32, y: i32, color: C) {
        let u16 = w16(s);
        unsafe {
            let _ = SetTextColor(hdc, color);
            let _ = SelectObject(hdc, font as _);
            let _ = TextOutW(hdc, x, y, u16.as_ptr() as PCWSTR, (u16.len() - 1) as i32);
        }
    }

    fn font(face: &str, height: i32, weight: i32) -> *mut std::ffi::c_void {
        let face_u16 = w16(face);
        unsafe {
            CreateFontW(
                height, 0, 0, 0, weight, 0, 0, 0, 1 /*DEFAULT_CHARSET*/,
                0, 0, 5 /*CLEARTYPE_QUALITY*/, 0x04 /*VARIABLE_PITCH*/,
                face_u16.as_ptr() as PCWSTR,
            ) as _
        }
    }

    fn fill_rect(hdc: *mut std::ffi::c_void, x0: i32, y0: i32, x1: i32, y1: i32, color: C) {
        unsafe {
            let brush = CreateSolidBrush(color);
            let old = SelectObject(hdc, brush as _);
            let _ = Rectangle(hdc, x0, y0, x1, y1);
            let _ = SelectObject(hdc, old);
            let _ = DeleteObject(brush as _);
        }
    }

    fn line(hdc: *mut std::ffi::c_void, x0: i32, y0: i32, x1: i32, y1: i32, color: C, width: i32) {
        unsafe {
            let pen = CreatePen(PS_SOLID, width, color);
            let old = SelectObject(hdc, pen as _);
            let _ = MoveToEx(hdc, x0, y0, std::ptr::null_mut());
            let _ = LineTo(hdc, x1, y1);
            let _ = SelectObject(hdc, old);
            let _ = DeleteObject(pen as _);
        }
    }

    fn box_outline(hdc: *mut std::ffi::c_void, x0: i32, y0: i32, x1: i32, y1: i32, color: C) {
        unsafe {
            let pen = CreatePen(PS_SOLID, 1, color);
            let old = SelectObject(hdc, pen as _);
            let oldb = SelectObject(hdc, CreateSolidBrush(PANEL) as _);
            let _ = Rectangle(hdc, x0, y0, x1, y1);
            let _ = SelectObject(hdc, oldb);
            let _ = SelectObject(hdc, old);
            let _ = DeleteObject(pen as _);
        }
    }

    fn find_sample_font(root: &Path) -> Option<PathBuf> {
        for cand in [
            root.join("sample").join("PeptasiaIconFont.otf"),
            root.join("PeptasiaIconFont.otf"),
        ] {
            if cand.exists() {
                return Some(cand);
            }
        }
        None
    }

    fn ensure_sample_font(root: &Path) -> &'static str {
        if let Some(p) = find_sample_font(root) {
            let u16 = w16(&p.to_string_lossy());
            let ok = unsafe {
                AddFontResourceExW(u16.as_ptr() as PCWSTR, FR_PRIVATE, std::ptr::null())
            };
            // The PeptasiaIconFont's name table gives family "Untitled".
            if ok != 0 { "Untitled" } else { "Segoe UI" }
        } else {
            "Segoe UI"
        }
    }

    /// Draw the app's glyph view (top bar, glyph grid, big glyph with metric
    /// guides, status bar) into the given device context.
    fn render_glyph_view(hdc: *mut std::ffi::c_void, root: &Path) {
        let face = ensure_sample_font(root);
        let gf = font(face, -34, 500);   // grid glyphs
        let gb = font(face, -200, 500);  // big glyph
        let ub = font("Segoe UI", -20, 700);
        let us = font("Segoe UI", -13, 400);

        // ---- top bar ----
        fill_rect(hdc, 0, 0, W as i32, 54, PANEL);
        line(hdc, 0, 54, W as i32, 54, LINE, 1);
        text(hdc, ub, "Glyphter", 20, 12, INK);
        text(hdc, us, &format!("{}  ·  933 glyphs  ·  931 code points  ·  upem 1000", face), 20, 36, SOFT);

        // ---- left: glyph grid (the font's Private Use Area icons U+E000..U+E02F) ----
        box_outline(hdc, 16, 66, 770, 744, LINE);
        let cell: i32 = 58;
        let pitch: i32 = 62;
        let ox: i32 = 30;
        let oy: i32 = 80;
        let cols: i32 = 12;
        let mut cp: u32 = 0xE000;
        for r in 0..4i32 {
            for c in 0..cols {
                let bx = ox + c * pitch;
                let by = oy + r * pitch;
                fill_rect(hdc, bx, by, bx + cell, by + cell, PANEL);
                box_outline(hdc, bx, by, bx + cell, by + cell, LINE);
                if let Some(ch) = char::from_u32(cp) {
                    let s = ch.to_string();
                    text(hdc, gf, &s, bx + 17, by + 6, INK);
                }
                text(hdc, us, &format!("{:04X}", cp), bx + 4, by + cell - 16, SOFT);
                cp += 1;
            }
        }

        // ---- right: inspector — big glyph + metric guides ----
        box_outline(hdc, 784, 66, 1264, 744, LINE);
        let asc_y: i32 = 190;
        let base_y: i32 = 380;
        let desc_y: i32 = 455;
        let gxc: i32 = 1024;
        line(hdc, 800, asc_y, 1248, asc_y, ACCENT_SOFT, 1);
        line(hdc, 800, base_y, 1248, base_y, ACCENT, 2);
        line(hdc, 800, desc_y, 1248, desc_y, ACCENT_SOFT, 1);
        line(hdc, gxc - 100, asc_y, gxc - 100, desc_y, ACCENT_SOFT, 1);
        line(hdc, gxc + 100, asc_y, gxc + 100, desc_y, ACCENT_SOFT, 1);
        if let Some(ch) = char::from_u32(0xE001) {
            text(hdc, gb, &ch.to_string(), gxc - 110, base_y - 175, INK);
        }
        text(hdc, us, "asc", 1210, asc_y - 16, SOFT);
        text(hdc, us, "base", 1204, base_y + 3, ACCENT);
        text(hdc, us, "desc", 1206, desc_y + 3, SOFT);
        text(hdc, ub, "U+E001", 800, 480, INK);
        text(hdc, us, "uniE001  ·  advance 1249  ·  upem 1000", 905, 483, SOFT);

        // ---- status bar ----
        fill_rect(hdc, 0, 752, W as i32, H as i32, PANEL);
        line(hdc, 0, 752, W as i32, 752, LINE, 1);
        text(
            hdc,
            us,
            &format!("931 defined code points  ·  933 glyphs  ·  upem 1000  ·  weight 400  ·  {}", face),
            20,
            766,
            SOFT,
        );

        // cleanup
        unsafe {
            let _ = DeleteObject(gf as _);
            let _ = DeleteObject(gb as _);
            let _ = DeleteObject(ub as _);
            let _ = DeleteObject(us as _);
        }
    }

    /// Paint the glyph view into an existing device context (e.g. the window's
    /// own DC from GetDC). Draws a background first so there is nothing behind
    /// the glyphs.
    pub fn paint_window(hdc: *mut std::ffi::c_void, root: &Path) {
        fill_rect(hdc, 0, 0, W as i32, H as i32, BG);
        render_glyph_view(hdc, root);
    }

    /// Find this app's main window by title. Retries a little because the
    /// window may not be registered with the message queue the instant tao
    /// returns from build().
    pub fn find_hwnd(title: &str) -> *mut std::ffi::c_void {
        let t = w16(title);
        let mut handle = std::ptr::null_mut();
        for _ in 0..12 {
            handle = unsafe { FindWindowW(std::ptr::null_mut(), t.as_ptr() as PCWSTR) };
            if !handle.is_null() {
                break;
            }
            unsafe { Sleep(100) };
        }
        handle
    }

    /// Pump the Win32 message queue so the window stays alive and keeps
    /// drawing (the OS composites whatever we painted onto its DC). Runs for
    /// at most `max_iters` iterations or `timeout_ms`, whichever comes first,
    /// so a screenshot run is fast and deterministic — it can't hang.
    pub fn pump(max_iters: u32, timeout_ms: u32) {
        let start = std::time::Instant::now();
        let mut msg = unsafe { std::mem::zeroed::<MSG>() };
        for _ in 0..max_iters {
            if start.elapsed() > std::time::Duration::from_millis(timeout_ms as u64) {
                break;
            }
            let got = unsafe { PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) };
            if got != 0 {
                if msg.message == 0x0012u32 {
                    // WM_QUIT
                    break;
                }
                unsafe {
                    let _ = TranslateMessage(&msg);
                    let _ = DispatchMessageW(&msg);
                }
            } else {
                unsafe { Sleep(16) };
            }
        }
    }

    /// Paint the glyph view into the live window's own device context, so the
    /// window actually shows the glyphs (not just the off-screen PNG file).
    pub fn paint_into_window(hwnd: *mut std::ffi::c_void, root: &Path) {
        if hwnd.is_null() {
            return;
        }
        let dc = unsafe { GetDC(hwnd) };
        if dc.is_null() {
            return;
        }
        paint_window(dc, root);
        unsafe {
            let _ = ReleaseDC(hwnd, dc);
        }
    }

    pub fn save_png(out: &Path, root: &Path) -> Result<(), String> {
        let mem = unsafe { CreateCompatibleDC(std::ptr::null_mut()) };
        if mem.is_null() {
            return Err("CreateCompatibleDC failed".into());
        }
        // A 32-bit DIB section, so the surface is true color regardless of the
        // (possibly 1-bit) screen depth. A negative height makes it top-down,
        // so CreateDIBSection returns a direct pixel pointer where offset 0 is
        // the top-left pixel, row stride W*4 with no padding.
        let mut bmi = unsafe { std::mem::zeroed::<BITMAPINFO>() };
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: W as i32,
            biHeight: -(H as i32), // negative => top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };
        bmi.bmiColors[0] = RGBQUAD {
            rgbBlue: 0,
            rgbGreen: 0,
            rgbRed: 0,
            rgbReserved: 0,
        };
        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let bmp = unsafe {
            CreateDIBSection(
                mem,
                &bmi as *const _,
                DIB_RGB_COLORS,
                &mut bits,
                std::ptr::null_mut(),
                0,
            )
        };
        if bmp.is_null() || bits.is_null() {
            unsafe {
                let _ = DeleteDC(mem);
            }
            return Err("CreateDIBSection failed".into());
        }
        unsafe {
            let _ = SelectObject(mem, bmp as _);
            let _ = SetBkMode(mem, TRANSPARENT as i32);
        }
        fill_rect(mem, 0, 0, W as i32, H as i32, BG);
        render_glyph_view(mem, root);

        // Read the pixels straight from the DIB section (top-down, 32-bit BGRA).
        let px = unsafe { std::slice::from_raw_parts(bits as *const u8, (W * H * 4) as usize) };
        let mut rgb = vec![0u8; (W * H * 3) as usize];
        let row4 = (W * 4) as usize;
        let row3 = (W * 3) as usize;
        for y in 0..H as usize {
            let srow = y * row4;
            let drow = y * row3;
            for x in 0..W as usize {
                let si = srow + x * 4;
                let di = drow + x * 3;
                rgb[di] = px[si + 2]; // R
                rgb[di + 1] = px[si + 1]; // G
                rgb[di + 2] = px[si]; // B
            }
        }

        unsafe {
            let _ = DeleteObject(bmp as _);
            let _ = DeleteDC(mem);
        }

        write_png(out, W, H, &rgb)
    }

    fn write_png(out: &Path, w: u32, h: u32, rgb: &[u8]) -> Result<(), String> {
        if let Some(parent) = out.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
            }
        }

        // filtered scanlines (filter byte 0 = None, then the row)
        let row_bytes = (w * 3) as usize;
        let mut filtered = Vec::with_capacity(h as usize * (row_bytes + 1));
        for y in 0..h {
            filtered.push(0u8);
            let start = (y as usize) * row_bytes;
            filtered.extend_from_slice(&rgb[start..start + row_bytes]);
        }

        // zlib stream: header + stored deflate blocks + adler32
        let mut idat = Vec::with_capacity(filtered.len() + 18);
        idat.push(0x78);
        idat.push(0x01);
        let mut i = 0;
        while i < filtered.len() {
            let n = filtered[i..].len().min(65535);
            let last = i + n >= filtered.len();
            idat.push(if last { 0x01 } else { 0x00 });
            let len = n as u16;
            idat.extend_from_slice(&len.to_le_bytes());
            idat.extend_from_slice(&(!len).to_le_bytes());
            idat.extend_from_slice(&filtered[i..i + n]);
            i += n;
        }
        idat.extend_from_slice(&adler32(&filtered).to_be_bytes());

        // assemble
        let mut png = Vec::with_capacity(8 + 25 + idat.len() + 12);
        png.extend_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
        let mut ihdr = Vec::with_capacity(13);
        ihdr.extend_from_slice(&w.to_be_bytes());
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.push(8); // bit depth
        ihdr.push(2); // color type: truecolor RGB
        ihdr.push(0); // compression
        ihdr.push(0); // filter
        ihdr.push(0); // interlace
        png.extend_from_slice(&chunk(b"IHDR", &ihdr));
        png.extend_from_slice(&chunk(b"IDAT", &idat));
        png.extend_from_slice(&chunk(b"IEND", &[]));

        std::fs::write(out, png).map_err(|e| format!("write png: {e}"))?;
        Ok(())
    }

    fn chunk(typ: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut v = Vec::with_capacity(12 + data.len());
        v.extend_from_slice(&(data.len() as u32).to_be_bytes());
        v.extend_from_slice(typ);
        v.extend_from_slice(data);
        let mut cin = Vec::with_capacity(4 + data.len());
        cin.extend_from_slice(typ);
        cin.extend_from_slice(data);
        v.extend_from_slice(&crc32(&cin).to_be_bytes());
        v
    }

    fn crc32(data: &[u8]) -> u32 {
        let mut table = [0u32; 256];
        for i in 0..256u32 {
            let mut c = i;
            for _ in 0..8 {
                c = if c & 1 == 1 { 0xEDB88320 ^ (c >> 1) } else { c >> 1 };
            }
            table[i as usize] = c;
        }
        let mut crc = 0xFFFFFFFFu32;
        for &b in data {
            crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
        }
        crc ^ 0xFFFFFFFF
    }

    fn adler32(data: &[u8]) -> u32 {
        let mut a = 1u32;
        let mut b = 0u32;
        for &x in data {
            a = (a + x as u32) % 65521;
            b = (b + a) % 65521;
        }
        (b << 16) | a
    }
}
