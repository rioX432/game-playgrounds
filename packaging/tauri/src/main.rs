// Tauri (WKWebView) host shell + measurement harness for the web-on-steam chapter (#175).
//
// WKWebView has no Chromium remote-debugging (CDP), so unlike the Electron runner we
// cannot harvest window.__renderSamples externally. Instead an initialization_script polls
// the in-page probe and, once the measurement windows are collected, hands the JSON back to
// Rust over Tauri IPC (`report`), which writes it to REPORT_FILE and exits. The external
// Node runner (measure.mjs) orchestrates launches and samples the process-tree RAM.
//
// Which web build is embedded is fixed at COMPILE time by tauri.conf.json `frontendDist`
// (three/dist here); the per-run measure URL (sample/backend/bodies/seed) is injected at
// RUNTIME via the MEASURE_QUERY env var. A RELEASE build is required for the WebGPU path
// (tauri#6381: WKWebView WebGPU init fails in Tauri dev builds, works in production).

use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{WebviewUrl, WebviewWindowBuilder};

fn debug_log(msg: &str) {
    if let Ok(p) = std::env::var("DEBUG_FILE") {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
            let _ = writeln!(f, "{msg}");
        }
    }
    eprintln!("[tauri] {msg}");
}

#[tauri::command]
fn log(msg: String) {
    debug_log(&format!("js: {msg}"));
}

#[tauri::command]
fn report(json: String, app: tauri::AppHandle) {
    debug_log(&format!("report received: {} bytes", json.len()));
    let path = std::env::var("REPORT_FILE").unwrap_or_else(|_| "tauri-report.json".into());
    let _ = std::fs::write(&path, json);
    app.exit(0);
}

fn epoch_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}

/// Read a config value from `--key value` argv (so it survives `open --args`, which does
/// NOT forward env vars), falling back to the env var `KEY`, then `default`.
fn arg_or_env(key_flag: &str, env_key: &str, default: &str) -> String {
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == key_flag) {
        if let Some(v) = args.get(i + 1) {
            return v.clone();
        }
    }
    std::env::var(env_key).unwrap_or_else(|_| default.to_string())
}

fn main() {
    let query = arg_or_env("--query", "MEASURE_QUERY", "");
    let report_file = arg_or_env("--report", "REPORT_FILE", "tauri-report.json");
    // REPORT_FILE is read again inside the `report` command via env; mirror it from argv so
    // the `open --args` path (no env) still writes to the right place.
    std::env::set_var("REPORT_FILE", &report_file);
    let max_windows: u64 = arg_or_env("--max-windows", "MAX_WINDOWS", "3").parse().unwrap_or(3);
    let timeout_ms: u64 = arg_or_env("--timeout", "TIMEOUT_MS", "45000").parse().unwrap_or(45000);
    let debug_file = arg_or_env("--debug", "DEBUG_FILE", "");
    if !debug_file.is_empty() {
        std::env::set_var("DEBUG_FILE", &debug_file);
    }
    let spawn = epoch_ms();

    // Polls the in-page probe; reports back over IPC once the windows are in (or on timeout).
    let script = format!(
        r#"
        window.__APP_SPAWN_EPOCH_MS = {spawn};
        (function () {{
          var MAXW = {maxw}, DEADLINE = Date.now() + {timeout};
          function ipc(cmd, args) {{
            if (window.__TAURI__ && window.__TAURI__.core) return window.__TAURI__.core.invoke(cmd, args);
            if (window.__TAURI_INTERNALS__) return window.__TAURI_INTERNALS__.invoke(cmd, args);
            throw new Error('no tauri ipc');
          }}
          try {{ ipc('log', {{ msg: 'init url=' + location.href + ' gpu=' + !!navigator.gpu +
            ' tauri=' + !!(window.__TAURI__ && window.__TAURI__.core) }}); }} catch (e) {{ document.title = 'NOIPC ' + e; }}
          window.addEventListener('error', function (e) {{
            try {{ ipc('log', {{ msg: 'JSERR ' + (e.message || e) + ' @' + (e.filename||'') + ':' + (e.lineno||0) }}); }} catch (x) {{}}
          }});
          window.addEventListener('unhandledrejection', function (e) {{
            try {{ ipc('log', {{ msg: 'REJECT ' + (e.reason && (e.reason.message || e.reason)) }}); }} catch (x) {{}}
          }});
          var ticks = 0;
          function done(reason) {{
            var s = window.__renderSamples || [];
            var payload = {{
              samples: s,
              timeToFirstSampleMs: (window.__firstSampleEpochMs || 0) - window.__APP_SPAWN_EPOCH_MS,
              hasNavigatorGpu: !!navigator.gpu,
              reason: reason
            }};
            try {{ ipc('report', {{ json: JSON.stringify(payload) }}); }}
            catch (e) {{ document.title = 'REPORT_ERR ' + e; }}
          }}
          function poll() {{
            var s = window.__renderSamples || [];
            if (s.length && window.__firstSampleEpochMs === undefined) window.__firstSampleEpochMs = Date.now();
            if ((ticks++ % 5) === 0) {{ try {{ ipc('log', {{ msg: 'samples=' + s.length + ' vis=' + document.visibilityState + ' t=' + Date.now() }}); }} catch (e) {{}} }}
            if (s.length >= MAXW) return done('complete');
            if (Date.now() > DEADLINE) return done('timeout');
            setTimeout(poll, 200);
          }}
          poll();
        }})();
        "#,
        spawn = spawn,
        maxw = max_windows,
        timeout = timeout_ms,
    );

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![report, log])
        .setup(move |app| {
            let path = if query.is_empty() {
                "index.html".to_string()
            } else {
                format!("index.html?{query}")
            };
            // WKWebView throttles timers/rAF when the window is occluded/unfocused, which
            // stalls the probe. Keep it visible, focused, and on top during measurement.
            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(path.into()))
                .title("Game Playgrounds Tauri")
                .inner_size(1280.0, 720.0)
                .visible(true)
                .focused(true)
                .always_on_top(true)
                .initialization_script(&script)
                .build()?;
            let _ = win.show();
            let _ = win.set_focus();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
