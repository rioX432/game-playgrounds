import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType, PhysicsConstraintAxis } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import {
  BallAndSocketConstraint,
  Physics6DoFConstraint,
  type Physics6DoFLimit,
} from "@babylonjs/core/Physics/v2/physicsConstraint";
import type { PhysicsConstraint } from "@babylonjs/core/Physics/v2/physicsConstraint";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import "@babylonjs/core/Meshes/Builders/groundBuilder";
import "@babylonjs/core/Meshes/Builders/capsuleBuilder";
import "@babylonjs/core/Physics/physicsEngineComponent";

import { getHavokPlugin } from "../../engine/havok";
import { createHud } from "../../engine/hud";
import { createGround, createLightPreset } from "../../engine/scene";
import type { Sample, SampleContext } from "../types";

// --- World. ---
const GRAVITY_Y = -9.81;
const GROUND_SIZE = 60;
const GROUND_COLOR = new Color3(0.16, 0.18, 0.22);

// --- Spawn pose. The figure spawns upright a little above the floor and flops.
const SPAWN = new Vector3(0, 4.0, 0); // pelvis height at spawn (drops from here)
const SPAWN_TILT_RAD = 0.25; // slight forward lean (about world +X) so it topples

// --- Bone material / physics tuning. ---
const BONE_COLOR = new Color3(0.85, 0.55, 0.37);
const BONE_RESTITUTION = 0.0; // no bounce — it should slap and settle
const BONE_FRICTION = 0.8; // grippy so limbs don't slide forever on the floor

// --- Interactions (07b). ---
// One fixed impulse magnitude per click — no charge-up. Tuned so a limb snaps
// away and the chain follows through without flinging the whole figure offscreen
// (see the "single fixed magnitude" feel note in the README).
const PUNCH_IMPULSE = 14;

// --- Per-bone masses (kg). Heavier core, lighter limbs, so it reads as a body
// collapsing rather than equal sticks. Named so 07b can retune without hunting.
const MASS_PELVIS = 6;
const MASS_TORSO = 8;
const MASS_HEAD = 3;
const MASS_UPPER_ARM = 1.5;
const MASS_LOWER_ARM = 1;
const MASS_UPPER_LEG = 3;
const MASS_LOWER_LEG = 2;

// --- Camera (fixed 3/4 view framing the figure; no orbit). ---
const CAMERA_ALPHA = -Math.PI / 2.6;
const CAMERA_BETA = Math.PI / 2.6;
const CAMERA_RADIUS = 11;
const CAMERA_TARGET = new Vector3(0, 1.3, 0);

// --- Humanoid dimensions (meters). Capsule `length` = TOTAL height (caps
// included); axis is local Y. Named consts so 07b can retune the skeleton. ---
const PELVIS_LEN = 0.5;
const PELVIS_RADIUS = 0.16;
const TORSO_LEN = 0.6;
const TORSO_RADIUS = 0.16;
const HEAD_LEN = 0.3;
const HEAD_RADIUS = 0.14;
const UPPER_ARM_LEN = 0.42;
const UPPER_ARM_RADIUS = 0.06;
const LOWER_ARM_LEN = 0.38;
const LOWER_ARM_RADIUS = 0.05;
const UPPER_LEG_LEN = 0.54;
const UPPER_LEG_RADIUS = 0.08;
const LOWER_LEG_LEN = 0.5;
const LOWER_LEG_RADIUS = 0.06;

const SHOULDER_X = 0.28; // half shoulder width
const HIP_X = 0.13; // half hip width

// Vertical stack offsets from the pelvis center (Y up). Computed so adjacent
// capsules meet near their caps, giving each joint a sensible anchor. The local
// offsets are baked into BONES below.
const PELVIS_Y = 0;
const TORSO_Y = PELVIS_Y + PELVIS_LEN / 2 + TORSO_LEN / 2 + 0.04;
const SHOULDER_Y = TORSO_Y + TORSO_LEN / 2; // top of torso
const HEAD_Y = SHOULDER_Y + HEAD_LEN / 2 + 0.04;
const HIP_Y = PELVIS_Y - PELVIS_LEN / 2; // bottom of pelvis
const UPPER_LEG_Y = HIP_Y - UPPER_LEG_LEN / 2;
const LOWER_LEG_Y = UPPER_LEG_Y - UPPER_LEG_LEN / 2 - LOWER_LEG_LEN / 2 - 0.02;
const UPPER_ARM_Y = SHOULDER_Y - UPPER_ARM_LEN / 2;
const LOWER_ARM_Y = UPPER_ARM_Y - UPPER_ARM_LEN / 2 - LOWER_ARM_LEN / 2 - 0.02;

/**
 * One bone of the ragdoll: a dynamic capsule body. `length` is the TOTAL capsule
 * height (Babylon's `CreateCapsule` includes the round caps), `radius` the cap
 * radius; the capsule runs along local Y. `offset` is the bone center relative to
 * the pelvis center, in the figure's UPRIGHT (pre-lean) local frame.
 */
interface BoneSpec {
  readonly name: string;
  readonly length: number;
  readonly radius: number;
  readonly mass: number;
  readonly offset: readonly [number, number, number];
}

type JointKind = "ball" | "hinge";

/**
 * A joint wires a parent bone to a child bone. `anchorParent` / `anchorChild`
 * are the pivot points in each bone's LOCAL space (capsule axis = Y), placed at
 * the meeting caps. A "ball" joint pins those points but leaves rotation free; a
 * "hinge" joint locks all translation + two angular axes and LIMITS rotation
 * about `axis` to `[minLimit, maxLimit]` radians, so elbows/knees bend one way.
 */
interface JointSpec {
  readonly parent: string;
  readonly child: string;
  readonly kind: JointKind;
  readonly anchorParent: readonly [number, number, number];
  readonly anchorChild: readonly [number, number, number];
  /** Hinge rotation axis in local space (hinge only). */
  readonly axis?: readonly [number, number, number];
  /** Hinge angular limits in radians (hinge only). */
  readonly limits?: readonly [number, number];
}

/**
 * The humanoid skeleton: 11 capsule bones. Data-driven so 07b (#26) can extend
 * it — add bones, retune masses/sizes — without touching {@link buildRagdoll}.
 */
const BONES: readonly BoneSpec[] = [
  { name: "pelvis", length: PELVIS_LEN, radius: PELVIS_RADIUS, mass: MASS_PELVIS, offset: [0, PELVIS_Y, 0] },
  { name: "torso", length: TORSO_LEN, radius: TORSO_RADIUS, mass: MASS_TORSO, offset: [0, TORSO_Y, 0] },
  { name: "head", length: HEAD_LEN, radius: HEAD_RADIUS, mass: MASS_HEAD, offset: [0, HEAD_Y, 0] },
  { name: "upperArmL", length: UPPER_ARM_LEN, radius: UPPER_ARM_RADIUS, mass: MASS_UPPER_ARM, offset: [SHOULDER_X, UPPER_ARM_Y, 0] },
  { name: "lowerArmL", length: LOWER_ARM_LEN, radius: LOWER_ARM_RADIUS, mass: MASS_LOWER_ARM, offset: [SHOULDER_X, LOWER_ARM_Y, 0] },
  { name: "upperArmR", length: UPPER_ARM_LEN, radius: UPPER_ARM_RADIUS, mass: MASS_UPPER_ARM, offset: [-SHOULDER_X, UPPER_ARM_Y, 0] },
  { name: "lowerArmR", length: LOWER_ARM_LEN, radius: LOWER_ARM_RADIUS, mass: MASS_LOWER_ARM, offset: [-SHOULDER_X, LOWER_ARM_Y, 0] },
  { name: "upperLegL", length: UPPER_LEG_LEN, radius: UPPER_LEG_RADIUS, mass: MASS_UPPER_LEG, offset: [HIP_X, UPPER_LEG_Y, 0] },
  { name: "lowerLegL", length: LOWER_LEG_LEN, radius: LOWER_LEG_RADIUS, mass: MASS_LOWER_LEG, offset: [HIP_X, LOWER_LEG_Y, 0] },
  { name: "upperLegR", length: UPPER_LEG_LEN, radius: UPPER_LEG_RADIUS, mass: MASS_UPPER_LEG, offset: [-HIP_X, UPPER_LEG_Y, 0] },
  { name: "lowerLegR", length: LOWER_LEG_LEN, radius: LOWER_LEG_RADIUS, mass: MASS_LOWER_LEG, offset: [-HIP_X, LOWER_LEG_Y, 0] },
];

// Hinge rotation axis for elbows/knees: local Z, so the limb bends in the
// sagittal (front-back) plane like a real elbow/knee.
const HINGE_AXIS: readonly [number, number, number] = [0, 0, 1];

// Hinge limits (radians). One-directional bend: knees/elbows fold toward the
// body (negative about local Z) but cannot hyper-extend the other way.
const KNEE_LIMIT: readonly [number, number] = [-2.2, 0.0];
const ELBOW_LIMIT: readonly [number, number] = [-2.2, 0.0];

/**
 * The joints wiring the skeleton. Spine/neck/shoulders/hips are ball joints
 * (free 3-axis swing); elbows/knees are hinges with hard angular limits so they
 * bend one way only. Anchors are local to each capsule (axis = Y), at the caps
 * where parent and child meet.
 */
const JOINTS: readonly JointSpec[] = [
  // Spine + neck (ball).
  { parent: "pelvis", child: "torso", kind: "ball", anchorParent: [0, PELVIS_LEN / 2, 0], anchorChild: [0, -TORSO_LEN / 2, 0] },
  { parent: "torso", child: "head", kind: "ball", anchorParent: [0, TORSO_LEN / 2, 0], anchorChild: [0, -HEAD_LEN / 2, 0] },
  // Shoulders (ball).
  { parent: "torso", child: "upperArmL", kind: "ball", anchorParent: [SHOULDER_X, TORSO_LEN / 2, 0], anchorChild: [0, UPPER_ARM_LEN / 2, 0] },
  { parent: "torso", child: "upperArmR", kind: "ball", anchorParent: [-SHOULDER_X, TORSO_LEN / 2, 0], anchorChild: [0, UPPER_ARM_LEN / 2, 0] },
  // Elbows (hinge).
  { parent: "upperArmL", child: "lowerArmL", kind: "hinge", anchorParent: [0, -UPPER_ARM_LEN / 2, 0], anchorChild: [0, LOWER_ARM_LEN / 2, 0], axis: HINGE_AXIS, limits: ELBOW_LIMIT },
  { parent: "upperArmR", child: "lowerArmR", kind: "hinge", anchorParent: [0, -UPPER_ARM_LEN / 2, 0], anchorChild: [0, LOWER_ARM_LEN / 2, 0], axis: HINGE_AXIS, limits: ELBOW_LIMIT },
  // Hips (ball).
  { parent: "pelvis", child: "upperLegL", kind: "ball", anchorParent: [HIP_X, -PELVIS_LEN / 2, 0], anchorChild: [0, UPPER_LEG_LEN / 2, 0] },
  { parent: "pelvis", child: "upperLegR", kind: "ball", anchorParent: [-HIP_X, -PELVIS_LEN / 2, 0], anchorChild: [0, UPPER_LEG_LEN / 2, 0] },
  // Knees (hinge).
  { parent: "upperLegL", child: "lowerLegL", kind: "hinge", anchorParent: [0, -UPPER_LEG_LEN / 2, 0], anchorChild: [0, LOWER_LEG_LEN / 2, 0], axis: HINGE_AXIS, limits: KNEE_LIMIT },
  { parent: "upperLegR", child: "lowerLegR", kind: "hinge", anchorParent: [0, -UPPER_LEG_LEN / 2, 0], anchorChild: [0, LOWER_LEG_LEN / 2, 0], axis: HINGE_AXIS, limits: KNEE_LIMIT },
];

/** A bone's mesh paired with the physics aggregate that drives it. */
export interface RagdollBone {
  readonly mesh: Mesh;
  readonly aggregate: PhysicsAggregate;
}

/**
 * The built ragdoll. `bones` maps a bone name → its mesh+aggregate (07b can look
 * a body up by name, or map a picked mesh back to its bone via `byMesh`), and
 * `constraints` is every joint constraint (disposed before the bodies). Returned
 * as a structure so 07b can add punch (find a bone, apply impulse) and reset
 * (tear this down, rebuild) WITHOUT touching the build/teardown machinery here.
 */
export interface Ragdoll {
  readonly bones: Map<string, RagdollBone>;
  readonly byMesh: Map<Mesh, RagdollBone>;
  readonly constraints: PhysicsConstraint[];
  /** Dispose every constraint, then every bone aggregate + mesh. Idempotent. */
  dispose(): void;
}

/**
 * Build the articulated ragdoll into `scene` at `spawn` (the pelvis position),
 * leaning slightly forward so it always topples. Data-driven: extend BONES /
 * JOINTS, not this function. Caller owns `dispose()`.
 *
 * Bodies are DYNAMIC capsule {@link PhysicsAggregate}s. Babylon auto-steps the
 * Havok world and syncs each aggregate's body → mesh every frame, so there is no
 * manual fixed-timestep loop here (unlike the Rapier sibling sample).
 */
export function buildRagdoll(
  scene: SampleContext["scene"],
  spawn: Vector3,
  material: StandardMaterial,
): Ragdoll {
  const bones = new Map<string, RagdollBone>();
  const byMesh = new Map<Mesh, RagdollBone>();
  const constraints: PhysicsConstraint[] = [];

  // Spawn lean applied to the whole figure (about world +X), so the rigid
  // upright pose tips forward as one piece and never balances.
  const lean = Quaternion.RotationAxis(new Vector3(1, 0, 0), SPAWN_TILT_RAD);

  // 1. One dynamic capsule body + mesh per bone, placed at the leaned spawn pose.
  for (const spec of BONES) {
    const mesh = MeshBuilder.CreateCapsule(
      `ragdoll_${spec.name}`,
      { height: spec.length, radius: spec.radius },
      scene,
    );
    mesh.material = material;

    // Rotate the bone's local offset by the lean, then translate by the spawn
    // point, so the whole figure tilts as one rigid pose.
    const offset = new Vector3(spec.offset[0], spec.offset[1], spec.offset[2]);
    const leaned = offset.applyRotationQuaternion(lean);
    mesh.position.copyFrom(spawn.add(leaned));
    mesh.rotationQuaternion = lean.clone();

    const aggregate = new PhysicsAggregate(
      mesh,
      PhysicsShapeType.CAPSULE,
      { mass: spec.mass, restitution: BONE_RESTITUTION, friction: BONE_FRICTION },
      scene,
    );

    const bone: RagdollBone = { mesh, aggregate };
    bones.set(spec.name, bone);
    byMesh.set(mesh, bone);
  }

  // 2. Wire the joints from the data-driven spec. parent = body A, child = body B.
  for (const j of JOINTS) {
    const parent = bones.get(j.parent);
    const child = bones.get(j.child);
    if (!parent || !child) continue; // spec-typo guard; keeps build robust

    const pivotA = new Vector3(j.anchorParent[0], j.anchorParent[1], j.anchorParent[2]);
    const pivotB = new Vector3(j.anchorChild[0], j.anchorChild[1], j.anchorChild[2]);

    let constraint: PhysicsConstraint;
    if (j.kind === "hinge") {
      // Hinge via a 6-DoF constraint: the rotation axis (`axisA`/`axisB`) is the
      // reference for the ANGULAR_X limit. We LOCK all three linear axes and the
      // two perpendicular angular axes (min=max=0 → the Havok plugin LOCKs them),
      // and LIMIT ANGULAR_X to the bone's natural bend range. Axes absent from the
      // list stay free, so we list every locked axis explicitly.
      const axis = new Vector3(...(j.axis ?? HINGE_AXIS));
      const [minLimit, maxLimit] = j.limits ?? KNEE_LIMIT;
      const limits: Physics6DoFLimit[] = [
        { axis: PhysicsConstraintAxis.LINEAR_X, minLimit: 0, maxLimit: 0 },
        { axis: PhysicsConstraintAxis.LINEAR_Y, minLimit: 0, maxLimit: 0 },
        { axis: PhysicsConstraintAxis.LINEAR_Z, minLimit: 0, maxLimit: 0 },
        { axis: PhysicsConstraintAxis.ANGULAR_Y, minLimit: 0, maxLimit: 0 },
        { axis: PhysicsConstraintAxis.ANGULAR_Z, minLimit: 0, maxLimit: 0 },
        { axis: PhysicsConstraintAxis.ANGULAR_X, minLimit, maxLimit },
      ];
      constraint = new Physics6DoFConstraint(
        { pivotA, pivotB, axisA: axis, axisB: axis.clone(), collision: false },
        limits,
        scene,
      );
    } else {
      // Ball-and-socket: pins the pivots, leaves all rotation free. `axisA`/
      // `axisB` only seed the constraint frame (any consistent axis works).
      const axis = new Vector3(0, 1, 0);
      constraint = new BallAndSocketConstraint(
        pivotA,
        pivotB,
        axis,
        axis.clone(),
        scene,
      );
    }

    parent.aggregate.body.addConstraint(child.aggregate.body, constraint);
    constraints.push(constraint);
  }

  let disposed = false;
  return {
    bones,
    byMesh,
    constraints,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Constraints BEFORE bodies, so the engine never references a freed body.
      for (const c of constraints) c.dispose();
      constraints.length = 0;
      for (const { aggregate, mesh } of bones.values()) {
        aggregate.dispose();
        mesh.dispose();
      }
      bones.clear();
      byMesh.clear();
    },
  };
}

function sample07Mount(ctx: SampleContext): () => void {
  const { scene, canvas } = ctx;
  scene.clearColor.set(0.06, 0.07, 0.1, 1);

  let disposed = false;
  const cleanups: Array<() => void> = [];

  // --- Lighting + ground (scene-owned; freed by scene.dispose). ---
  createLightPreset(scene);
  createGround(scene, { size: GROUND_SIZE, color: GROUND_COLOR });

  // --- Fixed 3/4 framing. No attachControl: depth is hard to judge (honest
  // trade-off, mirroring the Three sibling), but it keeps the sample legible. ---
  // The first camera constructed becomes scene.activeCamera; we keep no
  // reference because nothing here drives it (fixed framing).
  new ArcRotateCamera(
    "ragdollCam",
    CAMERA_ALPHA,
    CAMERA_BETA,
    CAMERA_RADIUS,
    CAMERA_TARGET.clone(),
    scene,
  );

  // --- Shared bone material (owned by this sample; disposed below). ---
  const boneMat = new StandardMaterial("ragdollBoneMat", scene);
  boneMat.diffuseColor = BONE_COLOR.clone();

  // --- HUD (controls overlay). ---
  const hud = createHud(ctx, {
    title: "Ragdoll",
    controls: [
      "Click limb — punch (impulse at hit point, along view dir)",
      "R — reset to spawn pose",
      "Ball shoulders/hips/neck + hinged elbows/knees",
      "Esc — back",
    ],
  });
  cleanups.push(() => hud.dispose());

  // The built ragdoll, populated after Havok loads. Nulled on dispose so nothing
  // touches a disposed body.
  let ragdoll: Ragdoll | null = null;

  // Async because Havok WASM loads on demand. Guard with `disposed` so a fast
  // sample switch during the await never builds the world or the ragdoll.
  void getHavokPlugin().then((plugin) => {
    if (disposed) return;
    scene.enablePhysics(new Vector3(0, GRAVITY_Y, 0), plugin);

    // Static floor collider so the ragdoll lands on something (mass 0 = static).
    const floor = MeshBuilder.CreateGround(
      "ragdollFloorCollider",
      { width: GROUND_SIZE, height: GROUND_SIZE },
      scene,
    );
    floor.isVisible = false; // the visible ground above is the look; this is the body
    const floorAgg = new PhysicsAggregate(
      floor,
      PhysicsShapeType.BOX,
      { mass: 0 },
      scene,
    );

    // Build the articulated figure; Babylon auto-steps + syncs body→mesh.
    ragdoll = buildRagdoll(scene, SPAWN.clone(), boneMat);

    cleanups.push(() => {
      // Ragdoll first (constraints before bodies, handled inside its dispose),
      // then the floor body + mesh. Null the ref so nothing can touch it after.
      ragdoll?.dispose();
      ragdoll = null;
      floorAgg.dispose();
      floor.dispose();
    });

    // --- Click-to-punch. Raycast the cursor against ONLY the bone meshes (the
    // predicate re-reads the CURRENT `ragdoll`, so it follows resets and bails
    // after dispose). On a hit, shove that bone along the camera view direction
    // with the impulse applied AT THE HIT POINT — off-centre hits impart spin
    // because the lever arm to the centre of mass is non-zero. `applyImpulse`
    // wakes a sleeping Havok body, so a flat, settled figure still reacts.
    const onPointerDown = (): void => {
      if (disposed || !ragdoll) return;
      const hit = scene.pick(scene.pointerX, scene.pointerY, (m) =>
        ragdoll?.byMesh.has(m as Mesh) ?? false,
      );
      if (!hit?.pickedMesh || !hit.pickedPoint) return;
      const bone = ragdoll.byMesh.get(hit.pickedMesh as Mesh);
      const camera = scene.activeCamera;
      if (!bone || !camera) return;
      const impulse = camera
        .getForwardRay(1)
        .direction.normalize()
        .scale(PUNCH_IMPULSE);
      bone.aggregate.body.applyImpulse(impulse, hit.pickedPoint);
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    cleanups.push(() =>
      canvas.removeEventListener("pointerdown", onPointerDown),
    );

    // --- R to reset (edge-triggered). Tear down the CURRENT ragdoll via its own
    // dispose (constraints → bodies, no leaked bodies/colliders/constraints) and
    // rebuild fresh bodies at the spawn pose — a rebuild, not a teleport, so
    // velocities are zeroed and no prestep workaround is needed. `e.repeat`
    // guards the browser key-repeat so a held R rebuilds once, not every frame.
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== "KeyR" || e.repeat) return;
      if (disposed || !ragdoll) return;
      ragdoll.dispose();
      ragdoll = buildRagdoll(scene, SPAWN.clone(), boneMat);
    };
    window.addEventListener("keydown", onKeyDown);
    cleanups.push(() => window.removeEventListener("keydown", onKeyDown));
  });

  return () => {
    disposed = true;
    for (const c of cleanups) c();
    boneMat.dispose();
  };
}

export const sample07: Sample = {
  id: "07-ragdoll-core",
  title: "Ragdoll Core (Havok joints)",
  summary:
    "REPO-style jank: an 11-capsule humanoid wired with ball + hinge physics joints drops and flops limp under gravity. Hinge limits keep elbows/knees from folding backward. Click a limb to punch it (impulse at the hit point); R rebuilds it to the spawn pose.",
  tags: ["physics", "havok", "joints", "ragdoll"],
  mount: sample07Mount,
};

export default sample07;
