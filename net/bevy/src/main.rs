//! Entry point for the net-bevy replication skeleton.
//!
//! This is the SPIKE binary (issue #145): it constructs the headless replication
//! `App` and runs it. No transport is bound and no entities are replicated yet —
//! the purpose is only to prove the `bevy_replicon` + `bevy_replicon_renet` stack
//! resolves and registers on Bevy 0.18. Real server/client roles land in #146.

use net_bevy::build_app;

fn main() {
    build_app().run();
}
