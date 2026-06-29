//! bevy-playground — a Bevy 0.18 game-mechanics gallery.
//!
//! Sibling of the TypeScript `../three` and `../babylon` playgrounds: same
//! sample lineup, Rust + Bevy. The app boots into a `Menu` listing every
//! sample; selecting one enters that sample's `AppState`, and leaving it
//! despawns the sample's `DespawnOnExit`-tagged entities (see `samples/mod.rs`
//! for THE CONTRACT every sample follows).
//!
//! Run for dev (fast incremental):  cargo run --features bevy/dynamic_linking
//! Verify (fastest):                cargo check
//! Headless tests (no window):      cargo test

mod engine;
mod samples;

use bevy::input::mouse::{MouseScrollUnit, MouseWheel};
use bevy::prelude::*;
use bevy::ui::ScrollPosition;
use bevy_rapier3d::prelude::*;

use engine::hud::FoundationHudPlugin;
use engine::input::FoundationInputPlugin;
use samples::{all, register_samples, AppState, SampleEntry};

/// Marks an entity belonging to the menu screen (despawned on leaving Menu).
#[derive(Component)]
struct MenuRoot;

/// Tags the scrollable container that holds the sample buttons. The list is
/// taller than the window once enough samples exist, so it scrolls.
#[derive(Component)]
struct MenuList;

/// Tags a menu button with the `AppState` it selects.
#[derive(Component)]
struct MenuButton(AppState);

fn main() {
    let mut app = App::new();

    app.add_plugins(DefaultPlugins.set(WindowPlugin {
        primary_window: Some(Window {
            title: "bevy-playground".into(),
            ..default()
        }),
        ..default()
    }))
    // Physics. `RapierPhysicsPlugin::<NoUserData>::default()` registers the
    // default Rapier context entity used by `ReadRapierContext`.
    .add_plugins(RapierPhysicsPlugin::<NoUserData>::default())
    // Shared foundation input (keyboard intent + pointer-lock mouse look).
    // Added ONCE here; samples READ its resources (see `engine/input.rs`).
    .add_plugins(FoundationInputPlugin)
    // Shared foundation HUD (frame-time diagnostics + FPS counter driver).
    // Added ONCE here; samples spawn per-sample HUD widgets via the helpers in
    // `engine/hud.rs` (see `spawn_controls_overlay` / `spawn_fps_counter`).
    .add_plugins(FoundationHudPlugin)
    .init_state::<AppState>()
    // Menu lifecycle.
    .add_systems(OnEnter(AppState::Menu), spawn_menu)
    .add_systems(OnExit(AppState::Menu), despawn_menu)
    .add_systems(
        Update,
        (menu_button_system, menu_scroll).run_if(in_state(AppState::Menu)),
    )
    // While inside any sample, Escape returns to the menu.
    .add_systems(
        Update,
        back_to_menu_on_escape.run_if(not(in_state(AppState::Menu))),
    );

    // Register every sample plugin (list lives in `samples/mod.rs`).
    register_samples(&mut app);

    app.run();
}

/// The menu needs a camera to render UI. We use a 3D camera so nothing special
/// is required; UI renders on top regardless.
fn spawn_menu(mut commands: Commands) {
    commands.spawn((Camera3d::default(), MenuRoot));

    // Root: fixed title at top, a scrollable list in the middle, fixed hint at
    // the bottom. The list grows to fill the leftover height and scrolls its
    // overflow, so every sample stays reachable no matter how many we add.
    commands
        .spawn((
            MenuRoot,
            Node {
                width: Val::Percent(100.0),
                height: Val::Percent(100.0),
                flex_direction: FlexDirection::Column,
                align_items: AlignItems::Center,
                justify_content: JustifyContent::FlexStart,
                padding: UiRect::vertical(Val::Px(16.0)),
                row_gap: Val::Px(12.0),
                ..default()
            },
        ))
        .with_children(|parent| {
            parent.spawn((
                Text::new("bevy-playground — pick a sample (scroll for more)"),
                TextFont {
                    font_size: 28.0,
                    ..default()
                },
                TextColor(Color::WHITE),
            ));

            // Scrollable list: takes the remaining vertical space and scrolls.
            parent
                .spawn((
                    MenuList,
                    Node {
                        flex_direction: FlexDirection::Column,
                        align_items: AlignItems::Center,
                        row_gap: Val::Px(12.0),
                        flex_grow: 1.0,
                        // min_height:0 lets a flex child shrink below its content
                        // size so `overflow: scroll` actually clips and scrolls.
                        min_height: Val::Px(0.0),
                        overflow: Overflow::scroll_y(),
                        ..default()
                    },
                    ScrollPosition(Vec2::ZERO),
                ))
                .with_children(|list| {
                    for SampleEntry { meta, state } in all() {
                        list.spawn((
                            MenuButton(state),
                            Button,
                            Node {
                                width: Val::Px(520.0),
                                padding: UiRect::all(Val::Px(10.0)),
                                flex_direction: FlexDirection::Column,
                                flex_shrink: 0.0,
                                row_gap: Val::Px(2.0),
                                ..default()
                            },
                            BackgroundColor(Color::srgb(0.15, 0.15, 0.18)),
                        ))
                        .with_children(|btn| {
                            btn.spawn((
                                Text::new(meta.title),
                                TextFont {
                                    font_size: 18.0,
                                    ..default()
                                },
                                TextColor(Color::WHITE),
                            ));
                            btn.spawn((
                                Text::new(meta.summary),
                                TextFont {
                                    font_size: 13.0,
                                    ..default()
                                },
                                TextColor(Color::srgb(0.7, 0.7, 0.75)),
                            ));
                        });
                    }
                });

            parent.spawn((
                Text::new("Scroll to see all samples · Press Esc inside a sample to return here."),
                TextFont {
                    font_size: 13.0,
                    ..default()
                },
                TextColor(Color::srgb(0.6, 0.6, 0.6)),
            ));
        });
}

/// Mouse-wheel scrolling for the sample list. The list is a flex child with
/// `overflow: scroll_y`; Bevy clamps the *rendered* offset during layout, but
/// the `ScrollPosition` component itself is not clamped, so we clamp it here
/// (against the computed content/viewport sizes) to avoid a dead scroll zone.
fn menu_scroll(
    mut wheel: MessageReader<MouseWheel>,
    window: Query<&Window>,
    mut list: Query<(&mut ScrollPosition, &ComputedNode), With<MenuList>>,
) {
    // One wheel "line" is ~one button-ish step; pixel deltas (trackpads) pass through.
    const LINE_PX: f32 = 28.0;
    let mut dy = 0.0;
    for ev in wheel.read() {
        dy += match ev.unit {
            MouseScrollUnit::Line => ev.y * LINE_PX,
            MouseScrollUnit::Pixel => ev.y,
        };
    }
    if dy == 0.0 {
        return;
    }
    // ComputedNode sizes are physical px; ScrollPosition is logical px.
    let scale = window.single().map(Window::scale_factor).unwrap_or(1.0);
    for (mut scroll, node) in &mut list {
        let max = ((node.content_size.y - node.size.y).max(0.0)) / scale;
        scroll.0.y = (scroll.0.y - dy).clamp(0.0, max);
    }
}

fn despawn_menu(mut commands: Commands, query: Query<Entity, With<MenuRoot>>) {
    for entity in &query {
        commands.entity(entity).despawn();
    }
}

/// Handles clicks + hover feedback on menu buttons and transitions state.
fn menu_button_system(
    mut interactions: Query<
        (&Interaction, &MenuButton, &mut BackgroundColor),
        Changed<Interaction>,
    >,
    mut next_state: ResMut<NextState<AppState>>,
) {
    for (interaction, button, mut bg) in &mut interactions {
        match interaction {
            Interaction::Pressed => {
                next_state.set(button.0);
            }
            Interaction::Hovered => {
                *bg = BackgroundColor(Color::srgb(0.25, 0.25, 0.30));
            }
            Interaction::None => {
                *bg = BackgroundColor(Color::srgb(0.15, 0.15, 0.18));
            }
        }
    }
}

fn back_to_menu_on_escape(
    keyboard: Res<ButtonInput<KeyCode>>,
    mut next_state: ResMut<NextState<AppState>>,
) {
    if keyboard.just_pressed(KeyCode::Escape) {
        next_state.set(AppState::Menu);
    }
}
