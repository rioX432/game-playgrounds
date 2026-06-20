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

mod samples;

use bevy::prelude::*;
use bevy_rapier3d::prelude::*;

use samples::{all, register_samples, AppState, SampleEntry};

/// Marks an entity belonging to the menu screen (despawned on leaving Menu).
#[derive(Component)]
struct MenuRoot;

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
    .init_state::<AppState>()
    // Menu lifecycle.
    .add_systems(OnEnter(AppState::Menu), spawn_menu)
    .add_systems(OnExit(AppState::Menu), despawn_menu)
    .add_systems(Update, menu_button_system.run_if(in_state(AppState::Menu)))
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

    // Root vertical list.
    commands
        .spawn((
            MenuRoot,
            Node {
                width: Val::Percent(100.0),
                height: Val::Percent(100.0),
                flex_direction: FlexDirection::Column,
                align_items: AlignItems::Center,
                justify_content: JustifyContent::Center,
                row_gap: Val::Px(12.0),
                ..default()
            },
        ))
        .with_children(|parent| {
            parent.spawn((
                Text::new("bevy-playground — pick a sample"),
                TextFont {
                    font_size: 28.0,
                    ..default()
                },
                TextColor(Color::WHITE),
            ));

            for SampleEntry { meta, state } in all() {
                parent
                    .spawn((
                        MenuButton(state),
                        Button,
                        Node {
                            width: Val::Px(520.0),
                            padding: UiRect::all(Val::Px(10.0)),
                            flex_direction: FlexDirection::Column,
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

            parent.spawn((
                Text::new("Press Esc inside a sample to return here."),
                TextFont {
                    font_size: 13.0,
                    ..default()
                },
                TextColor(Color::srgb(0.6, 0.6, 0.6)),
            ));
        });
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
