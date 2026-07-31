//! Thin Tauri shell for LazyOrch.
//!
//! All orchestration lives in the TypeScript daemon. This crate only hosts
//! the web UI and opens a native window — no run/task/gate logic in Rust.
//!
//! Shell / process-spawn plugins are intentionally omitted until ensureDaemon
//! or open-external-URL needs them (keeps the attack surface minimal).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running LazyOrch GUI");
}
