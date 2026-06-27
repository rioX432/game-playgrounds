// Maps interpolated authoritative poses onto Babylon.js meshes. Diffs the live
// entity set each frame: spawns a capsule+nose for new ids, removes meshes for
// ids that left, and updates transforms/flag highlight for the rest. Owns the
// GPU resources it creates and disposes them on teardown (no leaks). This is the
// Babylon sibling of web-three's render/players.ts — identical reconcile logic,
// different engine primitives.

import type { Scene } from "@babylonjs/core/scene";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
// Side-effect imports register the capsule + cylinder builders on MeshBuilder.
import "@babylonjs/core/Meshes/Builders/capsuleBuilder";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import { FLAG_FIRING } from "net-protocol";
import {
  COLOR_FIRING_EMISSIVE,
  COLOR_NOSE,
  COLOR_REMOTE,
  COLOR_SELF,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
} from "../config";
import type { InterpolatedPlayer } from "../net/snapshotBuffer";

interface PlayerView {
  /** Yaw/position pivot; disposing it recurses to the capsule + nose meshes. */
  root: TransformNode;
  /** Body material whose emissive is toggled by the FLAG_FIRING bit. */
  body: StandardMaterial;
}

const NO_EMISSIVE = Color3.Black();
const FIRING_EMISSIVE = Color3.FromHexString(COLOR_FIRING_EMISSIVE);

export class PlayerViews {
  private readonly views = new Map<string, PlayerView>();

  constructor(private readonly scene: Scene) {}

  /** Reconcile rendered meshes with the latest interpolated entity set. */
  sync(players: InterpolatedPlayer[], selfId: string): void {
    const seen = new Set<string>();

    for (const p of players) {
      seen.add(p.id);
      let view = this.views.get(p.id);
      if (!view) {
        view = this.create(p.id, p.id === selfId);
        this.views.set(p.id, view);
      }
      // Server positions are planar (y = 0); lift the capsule onto the ground.
      view.root.position.set(p.pos[0], PLAYER_HEIGHT / 2, p.pos[2]);
      // Server yaw = atan2(moveZ, moveX) in world x/z. Matrix.RotationY maps
      // local +x -> (cos, 0, -sin) (independent of scene handedness), so
      // rotation.y = -yaw points the nose (local +x) along movement — the same
      // mapping web-three uses, and verified to face the same SCREEN direction
      // now that the scene is right-handed (see render/scene.ts).
      view.root.rotation.y = -p.yaw;

      const firing = (p.flags & FLAG_FIRING) !== 0;
      view.body.emissiveColor = firing ? FIRING_EMISSIVE : NO_EMISSIVE;
    }

    for (const [id, view] of this.views) {
      if (!seen.has(id)) {
        this.disposeView(view);
        this.views.delete(id);
      }
    }
  }

  /** Remove and dispose every rendered player. */
  dispose(): void {
    for (const [id, view] of this.views) {
      this.disposeView(view);
      this.views.delete(id);
    }
  }

  private create(id: string, isSelf: boolean): PlayerView {
    const root = new TransformNode(`player:${id}`, this.scene);

    const body = new StandardMaterial(`body:${id}`, this.scene);
    body.diffuseColor = Color3.FromHexString(isSelf ? COLOR_SELF : COLOR_REMOTE);

    const capsule = MeshBuilder.CreateCapsule(
      `cap:${id}`,
      { height: PLAYER_HEIGHT, radius: PLAYER_RADIUS },
      this.scene,
    );
    capsule.material = body;
    capsule.parent = root;
    capsule.isPickable = false;

    // A nose cone pointing local +x makes the authoritative yaw legible. The
    // cone is built pointing +y; rotate -90deg about z to tip it toward +x.
    const noseMat = new StandardMaterial(`nose:${id}`, this.scene);
    // Lit diffuse only (no emissive), matching web-three's nose for feel parity.
    noseMat.diffuseColor = Color3.FromHexString(COLOR_NOSE);
    const nose = MeshBuilder.CreateCylinder(
      `noseMesh:${id}`,
      {
        height: PLAYER_RADIUS * 1.2,
        diameterTop: 0,
        diameterBottom: PLAYER_RADIUS,
        tessellation: 8,
      },
      this.scene,
    );
    nose.material = noseMat;
    nose.parent = root;
    nose.isPickable = false;
    nose.rotation.z = -Math.PI / 2; // tip toward +x
    nose.position = new Vector3(PLAYER_RADIUS * 1.1, 0, 0);

    return { root, body };
  }

  // dispose(doNotRecurse=false, disposeMaterialAndTextures=true): recursing
  // frees the capsule + nose meshes, and the flag frees their materials too.
  private disposeView(view: PlayerView): void {
    view.root.dispose(false, true);
  }
}
