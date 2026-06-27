// Maps interpolated authoritative poses onto Three.js meshes. Diffs the live
// entity set each frame: spawns meshes for new ids, removes meshes for ids that
// left, and updates transforms/flag highlight for the rest. Owns the GPU
// resources it creates and disposes them on teardown (no leaks).

import {
  CapsuleGeometry,
  Color,
  ConeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Scene,
} from "three";
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
  group: Group;
  body: MeshStandardMaterial;
}

const NO_EMISSIVE = new Color(0x000000);
const FIRING_EMISSIVE = new Color(COLOR_FIRING_EMISSIVE);

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
        view = this.create(p.id === selfId);
        this.scene.add(view.group);
        this.views.set(p.id, view);
      }
      // Server positions are planar (y = 0); lift the capsule onto the ground.
      view.group.position.set(p.pos[0], PLAYER_HEIGHT / 2, p.pos[2]);
      // Server yaw = atan2(moveZ, moveX) in world x/z; Three rotates +x toward
      // -z about +Y, so negate to make the nose point along movement.
      view.group.rotation.y = -p.yaw;

      const firing = (p.flags & FLAG_FIRING) !== 0;
      view.body.emissive.copy(firing ? FIRING_EMISSIVE : NO_EMISSIVE);
    }

    for (const [id, view] of this.views) {
      if (!seen.has(id)) {
        this.scene.remove(view.group);
        this.disposeView(view);
        this.views.delete(id);
      }
    }
  }

  /** Remove and dispose every rendered player. */
  dispose(): void {
    for (const [id, view] of this.views) {
      this.scene.remove(view.group);
      this.disposeView(view);
      this.views.delete(id);
    }
  }

  private create(isSelf: boolean): PlayerView {
    const group = new Group();

    const body = new MeshStandardMaterial({
      color: isSelf ? COLOR_SELF : COLOR_REMOTE,
    });
    const capsule = new Mesh(
      new CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT - PLAYER_RADIUS * 2, 4, 8),
      body,
    );
    group.add(capsule);

    // A nose cone pointing local +x makes the authoritative yaw legible.
    const nose = new Mesh(
      new ConeGeometry(PLAYER_RADIUS * 0.5, PLAYER_RADIUS * 1.2, 8),
      new MeshStandardMaterial({ color: COLOR_NOSE }),
    );
    nose.rotation.z = -Math.PI / 2; // tip toward +x
    nose.position.set(PLAYER_RADIUS * 1.1, 0, 0);
    group.add(nose);

    return { group, body };
  }

  private disposeView(view: PlayerView): void {
    view.group.traverse((obj) => {
      if (obj instanceof Mesh) {
        obj.geometry.dispose();
        const mat = obj.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    });
  }
}
