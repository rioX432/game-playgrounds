// three/webgpu build of the 13-stress-bodies scene (#172).
//
// RUNTIME-GRAPH RULE: Three symbols are VALUE-imported EXCLUSIVELY from `three/webgpu`
// (see engineWebgpu.ts header). The seeded scatter (`computeSpawnPositions`) and Rapier
// are renderer-agnostic, so they are reused verbatim from the classic sample — keeping
// body count / physics / seed IDENTICAL so the WebGPU numbers are directly comparable
// to the classic WebGLRenderer baseline.

import RAPIER from "@dimforge/rapier3d-compat";
import {
  BoxGeometry,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardNodeMaterial,
  PlaneGeometry,
  type Scene,
} from "three/webgpu";
import { computeSpawnPositions } from "../../samples/13-stress-bodies/spawn";
import { createRng } from "../../measure/rng";

// Physics + geometry constants — MUST stay identical to the classic 13-stress sample
// (src/samples/13-stress-bodies/index.ts) so cross-backend numbers are comparable.
const GRAVITY_Y = -9.81;
const BOX_HALF = 0.3;
const MAX_BODIES = 2000;
const FLOOR_HALF = 12;
const RESTITUTION = 0.1;
const BOX_COLOR = 0xff8844;
const GROUND_COLOR = 0x2a3b2f;
const FLOOR_THICKNESS_HALF = 0.1;

// Light preset — mirrors engine/scene.ts createLightPreset defaults.
const HEMI_SKY = 0xbfd4ff;
const HEMI_GROUND = 0x202020;
const HEMI_INTENSITY = 0.9;
const KEY_COLOR = 0xffffff;
const KEY_INTENSITY = 1.4;
const KEY_POSITION: readonly [number, number, number] = [5, 10, 4];

interface Body {
  mesh: Mesh;
  rb: RAPIER.RigidBody;
}

/** A running WebGPU stress scene: physics world + meshes, stepped each frame. */
export interface StressSceneWebgpu {
  /** Number of dynamic bodies currently in the world. */
  readonly bodyCount: number;
  /** Add `n` dynamic boxes (capped at the shared safety limit). */
  spawn(n: number): void;
  /** Advance physics one fixed step and sync mesh transforms. */
  step(): void;
  /** Free the physics world and the GPU resources this scene created. */
  dispose(): void;
}

/**
 * Build the WebGPU stress scene into `scene`. Rapier is initialized by the caller
 * (`await RAPIER.init()`) before this runs. `seed` drives the same deterministic
 * scatter as the classic sample so a given seed reproduces an identical layout.
 */
export function createStressSceneWebgpu(
  scene: Scene,
  seed: number,
): StressSceneWebgpu {
  const rng = createRng(seed);

  const hemi = new HemisphereLight(HEMI_SKY, HEMI_GROUND, HEMI_INTENSITY);
  scene.add(hemi);
  const dir = new DirectionalLight(KEY_COLOR, KEY_INTENSITY);
  dir.position.set(...KEY_POSITION);
  scene.add(dir);

  const groundGeo = new PlaneGeometry(FLOOR_HALF * 2, FLOOR_HALF * 2);
  const groundMat = new MeshStandardNodeMaterial({ color: GROUND_COLOR });
  const groundMesh = new Mesh(groundGeo, groundMat);
  groundMesh.rotation.x = -Math.PI / 2;
  scene.add(groundMesh);

  // Shared geometry + material for every box — one upload, many handles (matches the
  // classic sample's non-instanced approach so draw cost is comparable).
  const boxGeo = new BoxGeometry(BOX_HALF * 2, BOX_HALF * 2, BOX_HALF * 2);
  const boxMat = new MeshStandardNodeMaterial({ color: BOX_COLOR });

  const world = new RAPIER.World(new RAPIER.Vector3(0, GRAVITY_Y, 0));
  // Static floor collider matching the render ground.
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(FLOOR_HALF, FLOOR_THICKNESS_HALF, FLOOR_HALF),
    world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -FLOOR_THICKNESS_HALF, 0),
    ),
  );

  const bodies: Body[] = [];

  const spawn = (n: number): void => {
    const room = MAX_BODIES - bodies.length;
    const count = Math.min(n, room);
    if (count <= 0) return;
    for (const p of computeSpawnPositions(count, rng)) {
      const rb = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(BOX_HALF, BOX_HALF, BOX_HALF).setRestitution(
          RESTITUTION,
        ),
        rb,
      );
      const mesh = new Mesh(boxGeo, boxMat);
      scene.add(mesh);
      bodies.push({ mesh, rb });
    }
  };

  const step = (): void => {
    world.step();
    for (const b of bodies) {
      const t = b.rb.translation();
      const r = b.rb.rotation();
      b.mesh.position.set(t.x, t.y, t.z);
      b.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  };

  const dispose = (): void => {
    for (const b of bodies) scene.remove(b.mesh);
    bodies.length = 0;
    world.free();
    scene.remove(groundMesh);
    scene.remove(hemi);
    scene.remove(dir);
    boxGeo.dispose();
    boxMat.dispose();
    groundGeo.dispose();
    groundMat.dispose();
  };

  return {
    get bodyCount(): number {
      return bodies.length;
    },
    spawn,
    step,
    dispose,
  };
}
