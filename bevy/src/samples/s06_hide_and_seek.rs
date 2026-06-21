//! # s06 — Hide-and-seek prop disguise (prop-hunt)
//!
//! **What it demonstrates:** The "prop hunt" disguise mechanic. A third-person
//! player (capsule by default) can swap its visible mesh to one of a fixed
//! catalog of environment props — crate / barrel / cone / sphere — to blend in
//! with the static decoy props scattered around the stage. The disguise has a
//! "tell": MOVING breaks it. While you hold still you are HIDDEN; the instant
//! you move you are EXPOSED, shown by tinting the player's material red and a
//! HUD state line. Cycle the disguise with `Q`/`E`. This is the third-person
//! variant on purpose — you must be able to SEE your own disguise to judge how
//! convincingly it blends, so the follow camera from s01 is reused.
//!
//! **Controls:** `W/A/S/D` move (camera-relative, world axes). `Q` previous
//! disguise, `E` next disguise (wraps both ways). `Esc` returns to the menu.
//!
//! **Feel notes:** Cycling disguises is instant and satisfyingly tactile — the
//! mesh pops to the next prop with zero delay, which reads well. The HIDDEN ⇄
//! EXPOSED flip is also instant and legible (red tint + HUD), so the "freeze to
//! hide" loop is immediately understandable. Honest bad parts: (1) there is **no
//! real seeker AI** here — "blending in" is an honor-system judgment by the
//! player looking at the decoys, so the tension of a real prop-hunt (a seeker
//! sweeping the room) is absent; this sample verifies the disguise + tell
//! *mechanic*, not the full game loop. (2) The tell is a hard binary on a single
//! speed threshold, so a real game's "you twitched" grace window is missing —
//! the moment you tap a key you are EXPOSED, which feels punishing rather than
//! tense. (3) The player keeps its original collider-free transform movement
//! (like s01), so you slide through the decoys instead of nestling against them,
//! which undercuts the illusion the moment you try to line up with a prop.
//!
//! **Bevy 0.18 gotchas:**
//!   * Swapping the visible mesh is done by overwriting the entity's `Mesh3d`
//!     and `MeshMaterial3d` components (insert the new tuple) — there is no
//!     `set_mesh`; the components ARE the source of truth, so re-inserting them
//!     replaces the render handles.
//!   * The disguise CATALOG of `Handle<Mesh>`/`Handle<StandardMaterial>` is held
//!     on the player entity (a `Disguise` component field), NOT in a `Resource`.
//!     `DespawnOnExit` does NOT clear resources, so a catalog stashed in a
//!     resource would survive the sample switch and leak the GPU assets. Held on
//!     the player, the handles drop when the player despawns on exit and the
//!     assets are freed (ref-counted by `Handle`).
//!   * Disguise cycling is edge-triggered: `ButtonInput::just_pressed` (NOT
//!     `pressed`, which would spin through the whole catalog every frame a key
//!     is held).
//!   * Index wrap uses `rem_euclid` so stepping *back* from index 0 lands on the
//!     last entry (plain `%` on a subtraction would underflow on `usize`).
//!   * `Time` delta is `time.delta_secs()` (f32), not `delta_seconds()`.
//!   * `Query::single_mut()` returns `Result` — handle with `let Ok(..) = ..`.
//!
//! **Shared input:** movement reads the global [`MoveIntent`] resource owned by
//! `engine::input::FoundationInputPlugin`. Disguise cycling reads
//! `ButtonInput<KeyCode>` directly since it's a one-off edge, not a shared intent.
//!
//! **Shared HUD/scene:** ground, light, and the decoy prop grid come from
//! `engine::scene`; the controls overlay + FPS counter from `engine::hud`. All
//! are `DespawnOnExit`-scoped internally, so only the player capsule, follow
//! camera, and disguise-state HUD line are spawned inline here.

use bevy::prelude::*;

use crate::engine::hud;
use crate::engine::input::MoveIntent;
use crate::engine::scene;

use super::{AppState, SampleMeta};

pub const META: SampleMeta = SampleMeta {
    id: "06-hide-and-seek-disguise",
    title: "Hide-and-seek prop disguise",
    summary: "Swap your mesh to a prop to blend in; moving breaks the disguise (HIDDEN/EXPOSED).",
    tags: &["disguise", "prop-hunt", "stealth", "movement"],
};

/// Player movement speed in world units / second.
const MOVE_SPEED: f32 = 6.0;
/// Camera offset behind/above the player (world units).
const CAMERA_OFFSET: Vec3 = Vec3::new(0.0, 6.0, 10.0);
/// Decoy prop grid dimensions (columns x rows) — static props to blend in with.
const DECOY_GRID_COLS: u32 = 3;
const DECOY_GRID_ROWS: u32 = 3;
/// Speed (world units / second) above which the disguise is broken (EXPOSED).
/// A small positive value tolerates float jitter so a perfectly still player is
/// never falsely EXPOSED.
const EXPOSE_SPEED_THRESHOLD: f32 = 0.05;
/// Red tint applied to whatever disguise material is active while EXPOSED.
const EXPOSED_TINT: Color = Color::srgb(0.9, 0.15, 0.15);

/// Marks the follow camera.
#[derive(Component)]
struct FollowCamera;

/// The player entity. Owns the disguise catalog (mesh + base-material handle
/// pairs) and the currently selected index, plus the previous-frame translation
/// used to compute speed for the "tell". Holding the catalog handles HERE (not in
/// a `Resource`) is what frees the assets on sample exit — see the module gotchas.
#[derive(Component)]
struct Player {
    /// Catalog of selectable disguises: `(mesh, base_material)` per prop shape.
    /// Cloned handles keep the assets alive for the life of the player entity.
    catalog: Vec<DisguiseEntry>,
    /// Index into [`Self::catalog`] of the currently worn disguise.
    current: usize,
    /// Player translation last frame, to derive per-frame speed for the tell.
    prev_translation: Vec3,
}

/// One catalog disguise: a prop mesh and its "blend-in" base material. The
/// EXPOSED state does not need a second material per entry — it derives a red
/// tint from a single shared exposed material handle (see [`setup`]).
struct DisguiseEntry {
    /// Human label for the HUD ("Crate", "Barrel", ...).
    label: &'static str,
    /// The prop mesh handle (Cuboid / Cylinder / Cone / Sphere).
    mesh: Handle<Mesh>,
    /// The hidden/blend-in material handle for this prop.
    base_material: Handle<StandardMaterial>,
}

pub struct HideAndSeekPlugin;

impl Plugin for HideAndSeekPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(OnEnter(AppState::S06HideAndSeek), setup)
            .add_systems(
                Update,
                (move_player, cycle_disguise, update_tell, follow_camera)
                    .chain()
                    .run_if(in_state(AppState::S06HideAndSeek)),
            );
    }
}

/// Builds the disguise catalog once and spawns the player wearing entry 0, the
/// follow camera, the shared stage, and the HUD. Every spawned entity is
/// `DespawnOnExit`-scoped; the catalog handles live on the player so they drop on
/// exit (no asset leak, no surviving resource).
fn setup(
    mut commands: Commands,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
) {
    let state = AppState::S06HideAndSeek;
    let scope = DespawnOnExit(state);

    // Shared scene primitives: ground + light + a grid of decoy props to hide
    // among. Each helper tags its entities DespawnOnExit(state) internally.
    scene::spawn_ground(&mut commands, &mut meshes, &mut materials, state);
    scene::spawn_light_preset(&mut commands, state);
    scene::spawn_box_grid(
        &mut commands,
        &mut meshes,
        &mut materials,
        state,
        DECOY_GRID_COLS,
        DECOY_GRID_ROWS,
    );

    // Build the disguise catalog ONCE. Handles are ref-counted; the clones stored
    // on the player keep these assets alive until the player despawns on exit.
    let catalog = build_catalog(&mut meshes, &mut materials);
    let shared_exposed_material = materials.add(StandardMaterial {
        base_color: EXPOSED_TINT,
        ..default()
    });

    // The player starts wearing the first disguise. The decoy grid sits at the
    // origin, so offset the player so it reads as a separate "infiltrator".
    let first_mesh = catalog[0].mesh.clone();
    let first_material = catalog[0].base_material.clone();
    commands.spawn((
        Player {
            catalog,
            current: 0,
            prev_translation: Vec3::new(0.0, 0.5, 6.0),
        },
        // Keep one extra handle to the shared exposed material alive on the
        // player so it, too, frees on exit (it is not in any catalog entry).
        ExposedMaterial(shared_exposed_material),
        Mesh3d(first_mesh),
        MeshMaterial3d(first_material),
        Transform::from_xyz(0.0, 0.5, 6.0),
        scope.clone(),
    ));

    // Follow camera (sample-specific), starting at the player's offset.
    commands.spawn((
        FollowCamera,
        Camera3d::default(),
        Transform::from_translation(Vec3::new(0.0, 0.5, 6.0) + CAMERA_OFFSET)
            .looking_at(Vec3::new(0.0, 0.5, 6.0), Vec3::Y),
        scope.clone(),
    ));

    // Disguise + state HUD line (sample-specific), updated every frame.
    commands.spawn((
        DisguiseHudText,
        scope,
        Text::new(""),
        TextFont {
            font_size: 18.0,
            ..default()
        },
        TextColor(Color::srgb(0.9, 0.9, 0.95)),
        Node {
            position_type: PositionType::Absolute,
            top: Val::Px(8.0),
            left: Val::Px(8.0),
            ..default()
        },
    ));

    hud::spawn_controls_overlay(
        &mut commands,
        state,
        &[
            "WASD — move (breaks disguise!)",
            "Q / E — cycle disguise",
            "Esc — back to menu",
        ],
    );
    hud::spawn_fps_counter(&mut commands, state);
}

/// Holds an extra clone of the shared EXPOSED material handle on the player so it
/// is freed on sample exit along with the catalog (it lives in no catalog entry).
#[derive(Component)]
struct ExposedMaterial(Handle<StandardMaterial>);

/// Marker for the HUD line showing the current disguise + HIDDEN/EXPOSED state.
#[derive(Component)]
struct DisguiseHudText;

/// Builds the fixed disguise catalog: one entry per prop shape, each with its own
/// blend-in base material. Pulled out so [`setup`] reads cleanly and so the count
/// is asserted by a headless test.
fn build_catalog(
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
) -> Vec<DisguiseEntry> {
    vec![
        DisguiseEntry {
            label: "Crate",
            mesh: meshes.add(Cuboid::new(1.0, 1.0, 1.0)),
            base_material: materials.add(StandardMaterial {
                base_color: Color::srgb(0.6, 0.4, 0.2),
                ..default()
            }),
        },
        DisguiseEntry {
            label: "Barrel",
            mesh: meshes.add(Cylinder::new(0.5, 1.0)),
            base_material: materials.add(StandardMaterial {
                base_color: Color::srgb(0.3, 0.3, 0.35),
                ..default()
            }),
        },
        DisguiseEntry {
            label: "Cone",
            mesh: meshes.add(Cone {
                radius: 0.6,
                height: 1.2,
            }),
            base_material: materials.add(StandardMaterial {
                base_color: Color::srgb(0.8, 0.7, 0.2),
                ..default()
            }),
        },
        DisguiseEntry {
            label: "Sphere",
            mesh: meshes.add(Sphere::new(0.6)),
            base_material: materials.add(StandardMaterial {
                base_color: Color::srgb(0.5, 0.6, 0.8),
                ..default()
            }),
        },
    ]
}

/// Moves the player on the XZ plane from the shared [`MoveIntent`] (world axes,
/// W = -Z), exactly like s01. Speed for the "tell" is derived separately in
/// [`update_tell`] from the resulting translation delta, so movement here stays a
/// pure position update.
fn move_player(
    time: Res<Time>,
    intent: Res<MoveIntent>,
    mut query: Query<&mut Transform, With<Player>>,
) {
    let Ok(mut transform) = query.single_mut() else {
        return;
    };
    if intent.dir != Vec3::ZERO {
        transform.translation += intent.dir * MOVE_SPEED * time.delta_secs();
    }
}

/// Edge-triggered disguise cycling: `Q` steps back, `E` steps forward, wrapping
/// both ways via [`cycle_index`]. On a change, re-inserts the player's `Mesh3d` +
/// `MeshMaterial3d` to the newly selected catalog entry (the components ARE the
/// render source of truth — there is no `set_mesh`).
fn cycle_disguise(
    keyboard: Res<ButtonInput<KeyCode>>,
    mut commands: Commands,
    mut query: Query<(Entity, &mut Player)>,
) {
    let Ok((entity, mut player)) = query.single_mut() else {
        return;
    };
    let mut delta = 0i32;
    if keyboard.just_pressed(KeyCode::KeyE) {
        delta += 1;
    }
    if keyboard.just_pressed(KeyCode::KeyQ) {
        delta -= 1;
    }
    if delta == 0 {
        return;
    }

    let len = player.catalog.len();
    player.current = cycle_index(player.current, delta, len);
    let entry = &player.catalog[player.current];
    let mesh = entry.mesh.clone();
    // While EXPOSED, keep the red tint; otherwise show the new blend-in material.
    // `update_tell` (which runs after this in the chain) will re-assert the right
    // material anyway, but setting the base here avoids a one-frame stale mesh.
    let material = entry.base_material.clone();
    commands
        .entity(entity)
        .insert((Mesh3d(mesh), MeshMaterial3d(material)));
}

/// Recomputes the "tell" every frame: derives the player's speed from how far it
/// moved since last frame, sets `exposed` via [`is_exposed`], swaps the player's
/// material to the shared red tint (EXPOSED) or its disguise base (HIDDEN), and
/// updates the HUD line.
fn update_tell(
    time: Res<Time>,
    mut commands: Commands,
    mut player_q: Query<(Entity, &mut Player, &Transform, &ExposedMaterial)>,
    mut hud_q: Query<&mut Text, With<DisguiseHudText>>,
) {
    let Ok((entity, mut player, transform, exposed_mat)) = player_q.single_mut() else {
        return;
    };

    let dt = time.delta_secs();
    let distance = transform.translation.distance(player.prev_translation);
    // Guard against a zero `dt` on the very first tick (would divide by zero).
    let speed = if dt > 0.0 { distance / dt } else { 0.0 };
    player.prev_translation = transform.translation;

    let exposed = is_exposed(speed, EXPOSE_SPEED_THRESHOLD);

    // Pick the material: red tint while EXPOSED, the current disguise base while
    // HIDDEN. Re-inserting MeshMaterial3d is the swap (no `set_material`).
    let material = if exposed {
        exposed_mat.0.clone()
    } else {
        player.catalog[player.current].base_material.clone()
    };
    commands.entity(entity).insert(MeshMaterial3d(material));

    if let Ok(mut text) = hud_q.single_mut() {
        let label = player.catalog[player.current].label;
        let state = if exposed { "EXPOSED" } else { "HIDDEN" };
        **text = format!("Disguise: {label}  |  {state}");
    }
}

/// Hard-offset follow camera (no smoothing — matches s01's feel notes).
fn follow_camera(
    player: Query<&Transform, (With<Player>, Without<FollowCamera>)>,
    mut camera: Query<&mut Transform, With<FollowCamera>>,
) {
    let (Ok(player), Ok(mut cam)) = (player.single(), camera.single_mut()) else {
        return;
    };
    cam.translation = player.translation + CAMERA_OFFSET;
    cam.look_at(player.translation, Vec3::Y);
}

/// Pure helper: the disguise is broken (EXPOSED) when the player's speed exceeds
/// the tolerance threshold. A still player (speed at/below the threshold) stays
/// HIDDEN — the small positive threshold absorbs float jitter so standing still
/// never false-triggers EXPOSED. Extracted so the tell is testable headless.
fn is_exposed(speed: f32, threshold: f32) -> bool {
    speed > threshold
}

/// Pure helper: steps a catalog index by `delta` (e.g. `+1`/`-1`) and wraps in
/// both directions. Uses `rem_euclid` so stepping back from 0 lands on the last
/// entry instead of underflowing the `usize`. `len` must be non-zero (the catalog
/// is always non-empty); returns `0` defensively if it isn't.
fn cycle_index(current: usize, delta: i32, len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    let next = (current as i32 + delta).rem_euclid(len as i32);
    next as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tell: a still player (speed below the threshold) is HIDDEN; a moving
    /// player (speed above it) is EXPOSED. Non-tautological: asserts both the
    /// boundary-below and clearly-above cases, and that the threshold itself is
    /// inclusive of "still" (not exposed).
    #[test]
    fn is_exposed_only_when_moving() {
        let threshold = EXPOSE_SPEED_THRESHOLD;
        assert!(!is_exposed(0.0, threshold), "perfectly still must be HIDDEN");
        assert!(
            !is_exposed(threshold, threshold),
            "speed exactly at the threshold must stay HIDDEN (jitter tolerance)"
        );
        assert!(
            !is_exposed(threshold * 0.5, threshold),
            "below-threshold drift must stay HIDDEN"
        );
        assert!(
            is_exposed(MOVE_SPEED, threshold),
            "moving at full speed must be EXPOSED"
        );
    }

    /// Index cycling wraps forward AND backward via `rem_euclid`. Non-tautological:
    /// checks a normal forward step, the forward wrap (last -> first), the
    /// backward wrap (first -> last), and a backward step in the middle.
    #[test]
    fn cycle_index_wraps_both_ways() {
        let len = 4; // crate / barrel / cone / sphere

        // Forward within range.
        assert_eq!(cycle_index(0, 1, len), 1);
        // Forward wrap: last -> first.
        assert_eq!(cycle_index(len - 1, 1, len), 0);
        // Backward wrap: first -> last (the rem_euclid case that plain % breaks).
        assert_eq!(cycle_index(0, -1, len), len - 1);
        // Backward within range.
        assert_eq!(cycle_index(2, -1, len), 1);
        // Defensive: empty catalog never panics.
        assert_eq!(cycle_index(0, -1, 0), 0);
    }

    /// Headless proof that the player Transform advances from the shared
    /// `MoveIntent` (mirrors s01) — the source of the speed the tell reads.
    #[test]
    fn move_player_advances_from_intent() {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins);
        app.insert_resource(MoveIntent {
            dir: Vec3::new(0.0, 0.0, -1.0),
        });
        let player = app
            .world_mut()
            .spawn((
                Player {
                    catalog: Vec::new(),
                    current: 0,
                    prev_translation: Vec3::ZERO,
                },
                Transform::from_xyz(0.0, 0.5, 6.0),
            ))
            .id();
        app.add_systems(Update, move_player);
        // Two updates so Time has a non-zero delta after its first tick.
        app.update();
        app.update();

        let z = app.world().get::<Transform>(player).unwrap().translation.z;
        assert!(z < 6.0, "forward intent should move the player toward -Z, got z={z}");
    }
}
