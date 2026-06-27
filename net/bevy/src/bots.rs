//! Server-side simulated players (the N2 sync-entity load) — the Bevy mirror of
//! `net/server/src/bots/botDriver.ts`.
//!
//! Bots are pure server-internal **replicated** entities (no socket, no client),
//! so the synchronized-entity count scales 2 → 24 → 100+ without opening that many
//! real connections. Each bot carries the same replicated sim components as a
//! player (`NetPosition`, `RoleFlags`) plus `Replicated`, so it adds the exact
//! simulation + serialization + downlink-bandwidth load the stress scenarios are
//! measuring. Real connected clients (not bots) remain the RTT / snapshot-age
//! probes. Motion is a seeded random walk so a recorded seed reproduces every bot
//! trajectory (the #147 faithful-recording rule).

use bevy::math::Vec2;
use bevy::prelude::*;
use bevy_replicon::prelude::Replicated;

use crate::config::{BOT_DIR_CHANGE_PROB, FLAG_GROUNDED};
use crate::protocol::{NetPosition, RoleFlags};
use crate::rng::Rng;
use crate::server::LatestInput;

/// Marker + per-bot heading for a server-internal bot. The current move axis is
/// held between direction changes so a bot walks in a straight line until it
/// re-rolls (mirrors the web `BotState.move{X,Z}`).
#[derive(Component, Debug, Default, Clone, Copy)]
pub struct Bot {
    move_x: f32,
    move_z: f32,
}

/// Desired bot population — live-ramped by a scenario stage. `ramp_bots` spawns or
/// despawns to converge the actual count to this target.
#[derive(Resource, Default, Debug, Clone, Copy)]
pub struct BotTarget(pub usize);

/// The bot-motion RNG stream (seeded). A DEDICATED stream — never shared with the
/// loss-draw stream — so bot trajectories stay reproducible regardless of when
/// loss draws happen (carried over from the web `rng.ts` note).
#[derive(Resource)]
pub struct BotRng(pub Rng);

/// Spawn / despawn bots so the live count matches [`BotTarget`]. Spawning attaches
/// the replicated player bundle (replicon then replicates the new entity to every
/// client); despawning lets replicon propagate the removal automatically.
pub(crate) fn ramp_bots(
    mut commands: Commands,
    target: Res<BotTarget>,
    bots: Query<Entity, With<Bot>>,
) {
    let current = bots.iter().count();
    let want = target.0;
    if current < want {
        for _ in 0..(want - current) {
            commands.spawn((
                Bot::default(),
                Replicated,
                NetPosition::default(), // origin; the random walk spreads them out
                RoleFlags(FLAG_GROUNDED),
                LatestInput::default(),
            ));
        }
    } else if current > want {
        // Despawn any (count-only semantics — which bots leave does not matter).
        for entity in bots.iter().take(current - want) {
            commands.entity(entity).despawn();
        }
    }
}

/// Produce one seeded random-walk input per bot each fixed tick and drive its
/// authoritative input (mirrors `BotDriver.tick`). Bots never press buttons, so
/// they stay `FLAG_GROUNDED`-only and contribute pure position traffic.
pub(crate) fn drive_bots(mut rng: ResMut<BotRng>, mut bots: Query<(&mut Bot, &mut LatestInput)>) {
    for (mut bot, mut input) in &mut bots {
        if rng.0.next_f64() < BOT_DIR_CHANGE_PROB {
            let angle = rng.0.range(0.0, std::f64::consts::TAU);
            bot.move_x = angle.cos() as f32;
            bot.move_z = angle.sin() as f32;
        }
        input.drive(Vec2::new(bot.move_x, bot.move_z), 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::TICK_RATE;
    use bevy::app::App;
    use bevy::state::app::StatesPlugin;
    use bevy::MinimalPlugins;

    /// A minimal headless app with just the bot systems (no replicon/renet needed
    /// to test spawn/despawn ramping + deterministic drive).
    fn bot_app(seed: u32) -> App {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, StatesPlugin));
        app.insert_resource(Time::<Fixed>::from_hz(TICK_RATE));
        app.insert_resource(BotTarget(0));
        app.insert_resource(BotRng(Rng::new(seed)));
        app.add_systems(Update, ramp_bots);
        app.add_systems(FixedUpdate, drive_bots);
        app
    }

    fn bot_count(app: &mut App) -> usize {
        app.world_mut().query_filtered::<Entity, With<Bot>>().iter(app.world()).count()
    }

    #[test]
    fn ramps_up_and_down_to_target() {
        let mut app = bot_app(1);
        app.world_mut().resource_mut::<BotTarget>().0 = 24;
        app.update();
        assert_eq!(bot_count(&mut app), 24, "ramps up to target");

        app.world_mut().resource_mut::<BotTarget>().0 = 8;
        app.update();
        assert_eq!(bot_count(&mut app), 8, "ramps down to target");

        app.world_mut().resource_mut::<BotTarget>().0 = 0;
        app.update();
        assert_eq!(bot_count(&mut app), 0, "drains to zero");
    }

    #[test]
    fn drive_is_deterministic_for_a_seed() {
        // Two apps, same seed, same ramp: bot headings must match step-for-step.
        let headings = |seed: u32| {
            let mut app = bot_app(seed);
            app.world_mut().resource_mut::<BotTarget>().0 = 4;
            app.update(); // spawn
            // Advance several fixed ticks of real time so drive_bots runs.
            let mut out = Vec::new();
            for _ in 0..20 {
                app.update();
                let mut q = app.world_mut().query::<&Bot>();
                let mut frame: Vec<(i32, i32)> = q
                    .iter(app.world())
                    .map(|b| ((b.move_x * 1000.0) as i32, (b.move_z * 1000.0) as i32))
                    .collect();
                frame.sort_unstable();
                out.push(frame);
            }
            out
        };
        assert_eq!(headings(7), headings(7));
    }
}
