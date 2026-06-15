#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Symphony Board Standalone: the read-only UI plus the WHOLE backend in one app.
// On launch it prepares a per-user data directory, then spawns the bundled Node
// runtime running src/cli/app-server.ts (sync loop + control surface +
// /contract.json + /api/range) on 127.0.0.1:8787 and points the webview's UI at
// it. Quitting the app kills the sidecar; if the port is already serving (an
// earlier instance's daemon), it adopts that server instead of starting a
// second SQLite writer.
//
// Data layout (macOS: ~/Library/Application Support/com.sympoies.symphony-board.standalone/):
//   config/sources.json   created and edited in-app (Settings -> Sources) via
//                         the sidecar's config control plane; absent until the
//                         first-run onboarding saves one. Hand-editing remains
//                         a fallback — the daemon re-reads it per run.
//   secrets.env           KEY=VALUE provider tokens (names match token_env /
//                         fallback_token_envs);
//                         written in-app through the write-only secrets surface
//                         (SYMPHONY_SECRETS_FILE), hand-editable as a fallback
//   data/board state      SQLite store + emitted contract.json
//   logs/app-server.log   sidecar stdout/stderr

use std::fs;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, RunEvent};

const PORT: u16 = 8787;

struct Sidecar(Mutex<Option<Child>>);

fn port_open(port: u16) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn wait_for_port(port: u16, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if port_open(port) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

// Parse KEY=VALUE lines ('#' comments, blank lines, surrounding whitespace
// allowed). This file is how provider tokens reach the sidecar's environment;
// names must match each source's token_env or fallback_token_envs in
// config/sources.json.
fn read_env_file(path: &Path) -> Vec<(String, String)> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (key, value) = line.split_once('=')?;
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            Some((key.to_string(), value.trim().to_string()))
        })
        .collect()
}

const SECRETS_TEMPLATE: &str = "# Provider tokens for Symphony Board Standalone.\n\
# Lines are KEY=VALUE; '#' starts a comment. Names must match each source's\n\
# token_env or fallback_token_envs in config/sources.json. Settings -> Sources\n\
# writes entries here for you; hand edits also work and apply on the next sync run.\n\
# GITHUB_TOKEN=ghp_xxx\n\
# GITHUB_TOKEN_BACKUP=ghp_xxx_from_a_different_account\n\
# GITLAB_TOKEN=glpat-xxx\n";

fn ensure_data_layout(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    fs::create_dir_all(data_dir.join("config"))?;
    fs::create_dir_all(data_dir.join("data"))?;
    fs::create_dir_all(data_dir.join("logs"))?;

    // config/sources.json is deliberately NOT seeded: a missing config is the
    // state the in-app onboarding starts from (Settings -> Sources creates it
    // through the sidecar's config control plane).

    let secrets = data_dir.join("secrets.env");
    if !secrets.exists() {
        fs::write(&secrets, SECRETS_TEMPLATE)?;
    }

    Ok(data_dir)
}

fn spawn_backend(app: &AppHandle, data_dir: &Path) -> Result<Child, Box<dyn std::error::Error>> {
    // The sidecar Node runtime is bundled next to this executable
    // (tauri.conf.json bundle.externalBin).
    let node = std::env::current_exe()?
        .parent()
        .ok_or("app executable has no parent directory")?
        .join("node");
    let entry = app
        .path()
        .resolve("backend/src/cli/app-server.ts", BaseDirectory::Resource)?;

    let log_path = data_dir.join("logs").join("app-server.log");
    let mut log = OpenOptions::new().create(true).append(true).open(&log_path)?;
    let _ = writeln!(log, "--- launching app-server (port {PORT}) ---");
    let log_err = log.try_clone()?;

    let mut cmd = Command::new(node);
    cmd.arg("--disable-warning=ExperimentalWarning")
        .arg(entry)
        // cwd = the data dir, so the config's relative db_path and the relative
        // CONTRACT_OUT land under Application Support, never inside the app.
        .current_dir(data_dir)
        .env("SYMPHONY_CONFIG", data_dir.join("config").join("sources.json"))
        .env("SYMPHONY_SECRETS_FILE", data_dir.join("secrets.env"))
        .env("CONTRACT_OUT", data_dir.join("data").join("contract.json"))
        .env("HOST", "127.0.0.1")
        .env("PORT", PORT.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    for (key, value) in read_env_file(&data_dir.join("secrets.env")) {
        cmd.env(key, value);
    }
    Ok(cmd.spawn()?)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle();
            let data_dir = ensure_data_layout(handle)?;
            if port_open(PORT) {
                // An app-server is already listening (e.g. an earlier instance's
                // orphaned sidecar). Adopt it rather than spawn a second writer
                // against the same SQLite store.
                eprintln!("port {PORT} already serving; adopting the running app-server");
            } else {
                let child = spawn_backend(handle, &data_dir)?;
                *app.state::<Sidecar>().0.lock().unwrap() = Some(child);
                // Give the server a moment to bind so the UI's first contract
                // fetch does not race the daemon boot.
                wait_for_port(PORT, Duration::from_secs(5));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Symphony Board Standalone app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Sidecar>().0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
