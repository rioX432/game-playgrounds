//! Shared engine foundation modules — reusable plugins/helpers that samples
//! build on (added ONCE in `main.rs`, not per-sample).
//!
//! Unlike `samples/`, these are NOT gated on a single sample's `AppState`; they
//! provide cross-cutting infrastructure (input, and later HUD, scene primitives)
//! that every sample can read.

pub mod hud;
pub mod input;
pub mod nav;
pub mod scene;
