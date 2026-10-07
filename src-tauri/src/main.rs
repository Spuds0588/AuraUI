// Prevents an extra console window on Windows in release builds. Harmless elsewhere.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    auraui_lib::run()
}
