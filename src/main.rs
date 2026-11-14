// Glyphter — native host window.
// A small WebView2 (via wry) window that displays the same web UI that lives
// next to this binary (index.html, style.css, font.js, app.js, lib/, sample/).
// It also runs a tiny loopback static file server on an ephemeral port so the
// page's fetch() of the sample fonts works (browsers block fetch() over file://).
//
// The web app is unchanged and still opens standalone in a browser; this host
// just gives the app a real native program to start.

mod shot;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::thread;

use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop};
use tao::window::WindowBuilder;
use wry::WebViewBuilder;

// Find the folder that holds index.html, walking up from this executable so it
// works whether the binary is next to the web files or inside target/release/.
fn find_web_root() -> PathBuf {
    let start = match std::env::current_exe() {
        Ok(p) => p.parent().map(|x| x.to_path_buf()).unwrap_or_else(|| PathBuf::from(".")),
        Err(_) => PathBuf::from("."),
    };
    let mut d = start.clone();
    for _ in 0..6 {
        if d.join("index.html").exists() {
            return d;
        }
        match d.parent() {
            Some(p) => d = p.to_path_buf(),
            None => break,
        }
    }
    start
}

fn mime(name: &str) -> &'static str {
    if name.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if name.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if name.ends_with(".js") {
        "application/javascript; charset=utf-8"
    } else if name.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if name.ends_with(".ttf") {
        "font/ttf"
    } else if name.ends_with(".otf") {
        "font/otf"
    } else if name.ends_with(".woff") {
        "font/woff"
    } else if name.ends_with(".woff2") {
        "font/woff2"
    } else if name.ends_with(".png") {
        "image/png"
    } else if name.ends_with(".svg") {
        "image/svg+xml"
    } else {
        "application/octet-stream"
    }
}

fn resp(stream: &mut std::net::TcpStream, status: &str, ctype: &str, body: &[u8]) {
    let _ = stream.write_all(format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        status, ctype, body.len()
    ).as_bytes());
    let _ = stream.write_all(body);
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn font_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Normalise an uploaded file name to a safe on-disk name. Keeps ASCII
/// alphanumerics, '.', '_' and '-'; anything else becomes '-'. Refuses empty
/// results, names starting with '.' (no hidden files / traversal), and
/// anything longer than 64 chars.
fn sanitize_font_name(name: &str) -> Option<String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return None;
    }
    let safe: String = trimmed
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect();
    if safe.len() > 64 || safe == "-" || safe.starts_with('.') {
        return None;
    }
    Some(safe)
}

/// The folder where uploaded fonts are kept on disk.
fn fonts_dir(root: &Path) -> PathBuf {
    root.join("data").join("fonts")
}

fn list_fonts_json(root: &Path) -> Vec<u8> {
    let dir = fonts_dir(root);
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .filter_map(|e| e.file_name().to_string_lossy().into_owned().into())
        .collect();
    names.sort();
    let items: Vec<String> = names
        .iter()
        .map(|n| format!("{{\"name\":\"{}\"}}", n.replace('"', "\\\"")))
        .collect();
    format!("{{\"fonts\":[{}]}}", items.join(",")).into_bytes()
}

/// Handle one connection: the `/api/fonts` persistence API, else static files.
fn serve_request(stream: &mut std::net::TcpStream, root: &Path) {
    // Read the request head (up to the blank line), bounded.
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() > 256 * 1024 {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    // Split at the blank line, keeping the body as raw bytes (font uploads
    // are binary — a lossy UTF-8 conversion would corrupt them).
    let split = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
        .unwrap_or(buf.len());
    let request = String::from_utf8_lossy(&buf[..split]).into_owned();
    let mut body: Vec<u8> = buf[split..].to_vec();

    let first = request.lines().next().unwrap_or("");
    let mut it = first.split_whitespace();
    let method = it.next().unwrap_or("");
    let target = it.next().unwrap_or("/");
    let path = target.split('?').next().unwrap_or(target);
    let header = |name: &str| -> Option<String> {
        request.lines().skip(1).find_map(|l| {
            let mut p = l.splitn(2, ':');
            let k = p.next()?.trim().to_string();
            let v = p.next()?.trim().to_string();
            k.eq_ignore_ascii_case(name).then_some(v)
        })
    };

    // ---- persistence API: /api/fonts ----
    if path == "/api/fonts" {
        if method == "POST" {
            let content_length: usize = header("content-length")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            while body.len() < content_length && body.len() < 64 * 1024 * 1024 {
                let got = stream.read(&mut chunk).unwrap_or(0);
                if got == 0 {
                    break;
                }
                body.extend_from_slice(&chunk[..got]);
            }
            let raw = header("x-file-name").map(|s| url_decode(&s)).unwrap_or_default();
            let name = match sanitize_font_name(&raw) {
                Some(n) => n,
                None => {
                    resp(stream, "400 Bad Request", "text/plain", b"bad file name");
                    return;
                }
            };
            if body.is_empty() {
                resp(stream, "400 Bad Request", "text/plain", b"empty body");
                return;
            }
            let dir = fonts_dir(root);
            if std::fs::create_dir_all(&dir).is_err() {
                resp(stream, "500 Internal Server Error", "text/plain", b"cannot create data/fonts");
                return;
            }
            if std::fs::write(dir.join(&name), &body).is_ok() {
                resp(stream, "200 OK", "application/json", br#"{"ok":true}"#);
            } else {
                resp(stream, "500 Internal Server Error", "text/plain", b"write failed");
            }
            return;
        }
        if method == "GET" {
            resp(stream, "200 OK", "application/json; charset=utf-8", &list_fonts_json(root));
            return;
        }
        resp(stream, "405 Method Not Allowed", "text/plain", b"");
        return;
    }
    if let Some(name) = path.strip_prefix("/api/fonts/") {
        if method != "GET" {
            resp(stream, "405 Method Not Allowed", "text/plain", b"");
            return;
        }
        if !font_name_ok(name) {
            resp(stream, "400 Bad Request", "text/plain", b"bad file name");
            return;
        }
        let full = fonts_dir(root).join(name);
        match std::fs::read(&full) {
            Ok(b) => {
                resp(stream, "200 OK", "application/octet-stream", &b);
            }
            Err(_) => {
                resp(stream, "404 Not Found", "text/plain", b"not found");
            }
        }
        return;
    }

    // ---- static files ----
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    if rel.split('/').any(|seg| seg == ".." || seg == "\\\\") {
        resp(stream, "403 Forbidden", "text/plain", b"");
        return;
    }
    let full = root.join(rel);
    match std::fs::read(&full) {
        Ok(b) => resp(stream, "200 OK", mime(&full.to_string_lossy()), &b),
        Err(_) => resp(stream, "404 Not Found", "text/plain", b"not found"),
    }
}

/// `--screenshot <file.png>` mode: open a plain (no webview) window that is
/// unfocused and kept at the bottom of the Z-order, keep it drawing the real
/// glyph view, then save that view as a PNG and exit quickly. This gives the
/// host a verifiable, non-blank screenshot without depending on WebView2's
/// separate GPU process.
fn screenshot_mode(file: &str) -> i32 {
    let root = find_web_root();
    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Glyphter")
        .with_focused(false)
        .with_always_on_bottom(true)
        .build(&event_loop)
        .expect("failed to create window");
    let _ = window; // keep the window alive for the duration of the shot

    // Give the window a moment to register with the OS, then paint the glyph
    // view into its own DC so the window itself shows the glyphs.
    std::thread::sleep(std::time::Duration::from_millis(150));
    let hwnd = shot::find_hwnd("Glyphter");
    if !hwnd.is_null() {
        shot::paint_into_window(hwnd, &root);
    }

    // Keep the window alive and drawing for ~120 frames (~2 s), bounded by a
    // hard timeout so the run is fast and can never hang.
    shot::pump(120, 5000);
    if !hwnd.is_null() {
        shot::paint_into_window(hwnd, &root);
    }

    match shot::save_png(std::path::Path::new(file), &root) {
        Ok(()) => {
            eprintln!("saved screenshot to {file}");
            0
        }
        Err(e) => {
            eprintln!("screenshot failed: {e}");
            1
        }
    }
}

fn main() -> std::process::ExitCode {
    // Screenshot mode: `glyph-font-viewer --screenshot out.png`
    let args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|a| a == "--screenshot") {
        let file = args.get(pos + 1).cloned().unwrap_or_default();
        let code = screenshot_mode(&file);
        return if code == 0 {
            std::process::ExitCode::SUCCESS
        } else {
            std::process::ExitCode::FAILURE
        };
    }

    let root = find_web_root();

    // Loopback static server on an ephemeral port.
    let server_root = root.clone();
    let (tx, rx) = std::sync::mpsc::channel::<u16>();
    thread::spawn(move || {
        match TcpListener::bind("127.0.0.1:0") {
            Ok(listener) => {
                let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
                let _ = tx.send(port);
                for st in listener.incoming() {
                    if let Ok(mut st) = st {
                        let r = server_root.clone();
                        thread::spawn(move || serve_request(&mut st, &r));
                    }
                }
            }
            Err(e) => {
                eprintln!("loopback bind failed: {e}");
                let _ = tx.send(0);
            }
        }
    });
    let port = rx.recv().unwrap_or(0);
    let url = if port > 0 {
        format!("http://127.0.0.1:{port}/index.html")
    } else {
        let p = root.join("index.html");
        format!("file:///{}", p.to_string_lossy().replace('\\', "/"))
    };
    eprintln!("Glyphter hosting {url}");

    let event_loop = EventLoop::new();
    let window = WindowBuilder::new()
        .with_title("Glyphter")
        .build(&event_loop)
        .expect("failed to create window");

    let builder = WebViewBuilder::new().with_url(url);
    let webview = match builder.build(&window) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("failed to build webview: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let _webview = webview;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            *control_flow = ControlFlow::Exit;
        }
    });
}
