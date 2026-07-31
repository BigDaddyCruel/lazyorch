//! Thin Tauri shell for LazyOrch.
//!
//! All orchestration lives in the TypeScript daemon. This crate only hosts
//! the web UI and opens a native window — no run/task/gate logic in Rust.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running LazyOrch GUI");
}
