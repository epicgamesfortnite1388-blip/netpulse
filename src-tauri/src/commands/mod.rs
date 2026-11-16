//! Tauri IPC command modules.
//!
//! Narrow, typed commands exposing subsystems to the frontend. Each module owns
//! its own command surface; `main.rs` registers them all in a single
//! `generate_handler![...]`.

pub mod nani;
