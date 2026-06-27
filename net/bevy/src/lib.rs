//! net-bevy — Bevy 0.18 native server-authoritative replication SKELETON.
//!
//! This crate is the dependency SPIKE for the net/ chapter (issue #145). Its
//! ONLY job is to prove that `bevy_replicon` + `bevy_replicon_renet` resolve and
//! register against Bevy 0.18, so the version-compatibility landmine is stepped
//! on BEFORE any real server/client logic (#146) is written.
//!
//! There is intentionally NO gameplay, NO transport binding, and NO replicated
//! components here — only that the plugin groups construct on top of a headless
//! Bevy `App`. Real authority + interpolation logic arrives in #146.
//!
//! ## Plugin set (verified against docs.rs for replicon 0.40 / replicon_renet 0.16)
//! - [`MinimalPlugins`] — headless core (no window / GPU).
//! - [`StatesPlugin`] — replicon relies on Bevy states; with `MinimalPlugins`
//!   this is NOT included automatically (it ships with `DefaultPlugins`), so it
//!   must be added explicitly.
//! - `RepliconPlugins` — core replication (from `bevy_replicon`).
//! - `RepliconRenetPlugins` — the renet messaging backend (from
//!   `bevy_replicon_renet`); replicon itself does no I/O.

use bevy::prelude::*;
use bevy::state::app::StatesPlugin;
use bevy_replicon::prelude::*;
use bevy_replicon_renet::RepliconRenetPlugins;

/// Build the headless replication `App` skeleton.
///
/// `RepliconRenetPlugins` registers BOTH the server and client backend plugins
/// (its default features are `client` + `server` + `renet_netcode`), so a single
/// builder is enough for the spike — role-specific systems (server authority,
/// client interpolation) are deferred to #146.
pub fn build_app() -> App {
    let mut app = App::new();
    app.add_plugins((
        MinimalPlugins,
        StatesPlugin,
        RepliconPlugins,
        RepliconRenetPlugins,
    ));
    app
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The spike's acceptance, as a headless test: the replicon + renet plugin
    /// groups construct and a single update tick runs without panicking — proving
    /// version resolution AND plugin registration are sound on Bevy 0.18.
    #[test]
    fn app_builds_and_ticks_with_replicon_renet() {
        let mut app = build_app();
        app.update();
    }
}
