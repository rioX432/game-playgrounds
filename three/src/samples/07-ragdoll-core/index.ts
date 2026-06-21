import RAPIER from "@dimforge/rapier3d-compat";
import {
  CapsuleGeometry,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
} from "three";
import { Hud } from "../../engine/hud";
import { createGround, createLightPreset } from "../../engine/scene";
import type { Sample, SampleContext } from "../types";

// --- Physics tuning. ---
const GRAVITY_Y = -9.81;
const FIXED_DT = 1 / 60; // fixed physics timestep for stable joints
const MAX_FRAME_DT = 0.1; // clamp huge dt after a tab stall
const MAX_SUBSTEPS = 5; // cap accumulator catch-up to avoid spiral-of-death

// --- Stage. ---
const SCENE_BACKGROUND = 0x0c0f14;
const GROUND_Y = 0;
const FLOOR_HALF = 30;
const FLOOR_THICKNESS = 0.1;
const BONE_DENSITY = 1.0; // uniform density; capsule volume sets per-bone mass
const BONE_COLOR = 0xd98c5f;
const BONE_LINEAR_DAMPING = 0.15; // a touch of air drag so it settles
const BONE_ANGULAR_DAMPING = 0.4; // damp spin so limbs stop flailing forever

// --- Interaction (#12). A click raycasts to a bone and punches it. ---
// Impulse magnitude (kg·m/s) applied at the hit point along the camera's view
// direction, so clicking "shoves" the limb away from the viewer. Tuned to clearly
// knock a ~few-kg bone around without flinging the whole figure off-screen.
const PUNCH_IMPULSE = 6;

// --- Spawn pose. The ragdoll spawns upright a little above the floor and flops.
const SPAWN_Y = 4.0; // pelvis height at spawn (drops from here)
const SPAWN_TILT_RAD = 0.25; // slight forward lean so it never balances

// --- Camera (fixed 3/4 view framing the ragdoll). ---
const CAMERA_POS: [number, number, number] = [6, 5, 8];
const CAMERA_LOOK: [number, number, number] = [0, 1.5, 0];

// --- Joint limits (radians). Hinges (elbows/knees) get hard angular limits so
// the body bends like a body, not a pretzel. Ball joints (shoulders/hips/neck)
// use spherical joints, which in this rapier3d-compat build expose NO angular
// cone limit (see README) — angular damping keeps them from over-rotating. ---
const KNEE_LIMIT: [number, number] = [-2.3, 0.05]; // knee bends back, not forward
const ELBOW_LIMIT: [number, number] = [-2.3, 0.05]; // elbow bends one way only

/**
 * A bone is one dynamic rigid body shaped as a capsule. The capsule's main axis
 * is local Y; `halfHeight` is the cylinder half-length (excluding the caps) and
 * `radius` is the cap radius — both passed straight to Rapier's capsule collider
 * and to Three's CapsuleGeometry so mesh and collider match.
 */
interface BoneSpec {
  readonly name: string;
  /** Capsule cylinder half-height (the straight part, excluding the round caps). */
  readonly halfHeight: number;
  readonly radius: number;
  /** World-space spawn offset of the bone center, relative to the pelvis center. */
  readonly offset: readonly [number, number, number];
}

type JointKind = "spherical" | "revolute";

/**
 * A joint connects a parent bone to a child bone. `anchorParent` / `anchorChild`
 * are the attachment points in each bone's LOCAL space (capsule axis = Y). A
 * spherical joint pins those points but leaves rotation free (ball joint); a
 * revolute joint is a hinge about `axis` with optional `[min, max]` limits.
 */
interface JointSpec {
  readonly parent: string;
  readonly child: string;
  readonly kind: JointKind;
  readonly anchorParent: readonly [number, number, number];
  readonly anchorChild: readonly [number, number, number];
  /** Hinge axis in local space (revolute only). */
  readonly axis?: readonly [number, number, number];
  /** Hinge angular limits in radians (revolute only). */
  readonly limits?: readonly [number, number];
}

// --- Humanoid dimensions (meters). Kept as named consts so #12 can retune. ---
const PELVIS_HALF_H = 0.18;
const PELVIS_RADIUS = 0.16;
const TORSO_HALF_H = 0.22;
const TORSO_RADIUS = 0.16;
const HEAD_HALF_H = 0.04;
const HEAD_RADIUS = 0.14;
const UPPER_ARM_HALF_H = 0.16;
const UPPER_ARM_RADIUS = 0.06;
const LOWER_ARM_HALF_H = 0.15;
const LOWER_ARM_RADIUS = 0.05;
const UPPER_LEG_HALF_H = 0.2;
const UPPER_LEG_RADIUS = 0.08;
const LOWER_LEG_HALF_H = 0.2;
const LOWER_LEG_RADIUS = 0.06;

const SHOULDER_X = 0.28; // half shoulder width
const HIP_X = 0.13; // half hip width

// Vertical stack offsets from the pelvis center (Y up). Computed so adjacent
// capsules meet roughly at their caps for natural joint placement.
const PELVIS_Y = 0;
const TORSO_Y = PELVIS_Y + PELVIS_HALF_H + TORSO_HALF_H + 0.05;
const SHOULDER_Y = TORSO_Y + TORSO_HALF_H; // top of torso
const HEAD_Y = SHOULDER_Y + HEAD_RADIUS + 0.06;
const HIP_Y = PELVIS_Y - PELVIS_HALF_H; // bottom of pelvis
const UPPER_LEG_Y = HIP_Y - UPPER_LEG_HALF_H - UPPER_LEG_RADIUS;
const LOWER_LEG_Y = UPPER_LEG_Y - UPPER_LEG_HALF_H - LOWER_LEG_HALF_H - 0.04;
const UPPER_ARM_Y = SHOULDER_Y - UPPER_ARM_HALF_H;
const LOWER_ARM_Y = UPPER_ARM_Y - UPPER_ARM_HALF_H - LOWER_ARM_HALF_H - 0.03;

/**
 * The humanoid skeleton: 11 capsule bones. Data-driven so #12 (interactions +
 * reset) can extend it without touching the build logic.
 */
const BONES: readonly BoneSpec[] = [
  { name: "pelvis", halfHeight: PELVIS_HALF_H, radius: PELVIS_RADIUS, offset: [0, PELVIS_Y, 0] },
  { name: "torso", halfHeight: TORSO_HALF_H, radius: TORSO_RADIUS, offset: [0, TORSO_Y, 0] },
  { name: "head", halfHeight: HEAD_HALF_H, radius: HEAD_RADIUS, offset: [0, HEAD_Y, 0] },
  { name: "upperArmL", halfHeight: UPPER_ARM_HALF_H, radius: UPPER_ARM_RADIUS, offset: [SHOULDER_X, UPPER_ARM_Y, 0] },
  { name: "lowerArmL", halfHeight: LOWER_ARM_HALF_H, radius: LOWER_ARM_RADIUS, offset: [SHOULDER_X, LOWER_ARM_Y, 0] },
  { name: "upperArmR", halfHeight: UPPER_ARM_HALF_H, radius: UPPER_ARM_RADIUS, offset: [-SHOULDER_X, UPPER_ARM_Y, 0] },
  { name: "lowerArmR", halfHeight: LOWER_ARM_HALF_H, radius: LOWER_ARM_RADIUS, offset: [-SHOULDER_X, LOWER_ARM_Y, 0] },
  { name: "upperLegL", halfHeight: UPPER_LEG_HALF_H, radius: UPPER_LEG_RADIUS, offset: [HIP_X, UPPER_LEG_Y, 0] },
  { name: "lowerLegL", halfHeight: LOWER_LEG_HALF_H, radius: LOWER_LEG_RADIUS, offset: [HIP_X, LOWER_LEG_Y, 0] },
  { name: "upperLegR", halfHeight: UPPER_LEG_HALF_H, radius: UPPER_LEG_RADIUS, offset: [-HIP_X, UPPER_LEG_Y, 0] },
  { name: "lowerLegR", halfHeight: LOWER_LEG_HALF_H, radius: LOWER_LEG_RADIUS, offset: [-HIP_X, LOWER_LEG_Y, 0] },
];

// Hinge axis for elbows/knees: local Z, so the limb bends in the sagittal plane.
const HINGE_AXIS: readonly [number, number, number] = [0, 0, 1];

/**
 * The joints wiring the skeleton together. Shoulders/hips/neck are spherical
 * (ball joints); elbows/knees are revolute hinges with limits. Anchors are local
 * to each capsule (axis = Y), placed at the meeting caps of parent and child.
 */
const JOINTS: readonly JointSpec[] = [
  // Spine + neck (ball joints, free rotation).
  { parent: "pelvis", child: "torso", kind: "spherical", anchorParent: [0, PELVIS_HALF_H, 0], anchorChild: [0, -TORSO_HALF_H, 0] },
  { parent: "torso", child: "head", kind: "spherical", anchorParent: [0, TORSO_HALF_H, 0], anchorChild: [0, -HEAD_RADIUS, 0] },
  // Shoulders (ball joints).
  { parent: "torso", child: "upperArmL", kind: "spherical", anchorParent: [SHOULDER_X, TORSO_HALF_H, 0], anchorChild: [0, UPPER_ARM_HALF_H, 0] },
  { parent: "torso", child: "upperArmR", kind: "spherical", anchorParent: [-SHOULDER_X, TORSO_HALF_H, 0], anchorChild: [0, UPPER_ARM_HALF_H, 0] },
  // Elbows (hinges).
  { parent: "upperArmL", child: "lowerArmL", kind: "revolute", anchorParent: [0, -UPPER_ARM_HALF_H, 0], anchorChild: [0, LOWER_ARM_HALF_H, 0], axis: HINGE_AXIS, limits: ELBOW_LIMIT },
  { parent: "upperArmR", child: "lowerArmR", kind: "revolute", anchorParent: [0, -UPPER_ARM_HALF_H, 0], anchorChild: [0, LOWER_ARM_HALF_H, 0], axis: HINGE_AXIS, limits: ELBOW_LIMIT },
  // Hips (ball joints).
  { parent: "pelvis", child: "upperLegL", kind: "spherical", anchorParent: [HIP_X, -PELVIS_HALF_H, 0], anchorChild: [0, UPPER_LEG_HALF_H, 0] },
  { parent: "pelvis", child: "upperLegR", kind: "spherical", anchorParent: [-HIP_X, -PELVIS_HALF_H, 0], anchorChild: [0, UPPER_LEG_HALF_H, 0] },
  // Knees (hinges).
  { parent: "upperLegL", child: "lowerLegL", kind: "revolute", anchorParent: [0, -UPPER_LEG_HALF_H, 0], anchorChild: [0, LOWER_LEG_HALF_H, 0], axis: HINGE_AXIS, limits: KNEE_LIMIT },
  { parent: "upperLegR", child: "lowerLegR", kind: "revolute", anchorParent: [0, -UPPER_LEG_HALF_H, 0], anchorChild: [0, LOWER_LEG_HALF_H, 0], axis: HINGE_AXIS, limits: KNEE_LIMIT },
];

/** A Three mesh paired with the Rapier body that drives it. */
interface BoneBody {
  readonly mesh: Mesh;
  readonly rb: RAPIER.RigidBody;
}

/**
 * Build the articulated ragdoll into `world` and `scene`. Returns the per-bone
 * mesh/body pairs (to sync each frame) and the spawn quaternion (for respawn).
 * Modular + data-driven: extend BONES / JOINTS, not this function.
 */
function buildRagdoll(
  world: RAPIER.World,
  spawn: (bone: BoneSpec) => { rb: RAPIER.RigidBody; mesh: Mesh },
): { bones: Map<string, BoneBody> } {
  const bones = new Map<string, BoneBody>();

  // 1. Spawn one dynamic capsule body + mesh per bone.
  for (const spec of BONES) {
    const { rb, mesh } = spawn(spec);
    bones.set(spec.name, { rb, mesh });
  }

  // 2. Wire the joints from the data-driven spec.
  for (const j of JOINTS) {
    const parent = bones.get(j.parent);
    const child = bones.get(j.child);
    if (!parent || !child) continue; // spec typo guard; keeps build robust
    const a1 = new RAPIER.Vector3(...j.anchorParent);
    const a2 = new RAPIER.Vector3(...j.anchorChild);

    let data: RAPIER.JointData;
    if (j.kind === "revolute") {
      const axis = new RAPIER.Vector3(...(j.axis ?? HINGE_AXIS));
      data = RAPIER.JointData.revolute(a1, a2, axis);
      if (j.limits) {
        // Hard hinge limits keep elbows/knees from bending the wrong way. Set on
        // the JointData (data-driven) so intoRaw() applies them at creation.
        data.limitsEnabled = true;
        data.limits = [j.limits[0], j.limits[1]];
      }
    } else {
      data = RAPIER.JointData.spherical(a1, a2);
    }
    // wakeUp=true; parent is body1, child is body2.
    world.createImpulseJoint(data, parent.rb, child.rb, true);
  }

  return { bones };
}

const sample: Sample = {
  id: "07-ragdoll-core",
  title: "Ragdoll",
  summary:
    "REPO-style jank: an 11-capsule humanoid wired with spherical + hinge physics joints drops and flops under gravity. Click a limb to punch it (impulse at the hit point); press R to reset to the spawn pose. Hinge limits keep elbows/knees from folding the wrong way.",
  tags: ["physics", "rapier", "joints", "ragdoll", "interaction"],

  mount(ctx: SampleContext): () => void {
    const { scene, camera, canvas } = ctx;

    const lights = createLightPreset(scene, { background: SCENE_BACKGROUND });
    const ground = createGround(scene, { size: FLOOR_HALF * 2 });

    // Fixed 3/4 framing — no input controller needed for the core flop.
    camera.position.set(...CAMERA_POS);
    camera.lookAt(...CAMERA_LOOK);

    const hud = new Hud({
      container: canvas.parentElement ?? undefined,
      title: "Ragdoll",
      controls: [
        "Click a limb — punch it (impulse at the hit point)",
        "R — reset the ragdoll to the spawn pose",
        "Spherical shoulders/hips/neck + hinged elbows/knees",
      ],
    });

    // One geometry + material per bone. Each bone needs its own CapsuleGeometry
    // (sizes differ); all share one material. Tracked for disposal.
    const boneGeometries = new Map<string, CapsuleGeometry>();
    const boneMaterial = new MeshStandardMaterial({ color: BONE_COLOR });
    const boneMeshes: Mesh[] = [];

    // R resets the ragdoll; read off a plain keydown listener.
    let respawnRequested = false;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code === "KeyR") respawnRequested = true;
    };
    window.addEventListener("keydown", onKeyDown);

    // --- Physics state (built after async Rapier init). ---
    let disposed = false;
    let raf = 0;
    let world: RAPIER.World | null = null;
    let bones: Map<string, BoneBody> | null = null;

    // --- Click-to-punch picking. Raycast from the camera through the cursor; if
    // it hits a bone mesh, punch that bone with an impulse at the hit point. ---
    const raycaster = new Raycaster();
    const pointerNdc = new Vector2(); // cursor position in normalised device coords
    const camDir = new Vector3(); // camera forward, reused as the punch direction
    const onClick = (e: MouseEvent): void => {
      if (!world || !bones) return; // null-safe: ignore clicks before/after the world
      // Cursor → NDC (relative to the canvas, not the window).
      const rect = canvas.getBoundingClientRect();
      pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNdc, camera);

      const boneList = Array.from(bones.values());
      const hits = raycaster.intersectObjects(
        boneList.map((b) => b.mesh),
        false,
      );
      if (hits.length === 0) return; // no-hit: never punch a null body

      const hit = hits[0];
      const target = boneList.find((b) => b.mesh === hit.object);
      if (!target) return; // mesh not mapped to a bone (shouldn't happen) — bail

      // Punch along the camera's view direction (shove the limb away from us),
      // applied at the exact hit point so off-centre clicks impart spin.
      camera.getWorldDirection(camDir);
      target.rb.applyImpulseAtPoint(
        new RAPIER.Vector3(
          camDir.x * PUNCH_IMPULSE,
          camDir.y * PUNCH_IMPULSE,
          camDir.z * PUNCH_IMPULSE,
        ),
        new RAPIER.Vector3(hit.point.x, hit.point.y, hit.point.z),
        true, // wake the body
      );
    };
    canvas.addEventListener("click", onClick);

    // Spawn orientation: a slight forward lean so it always topples (no balance).
    const spawnQuat = new Quaternion().setFromAxisAngle(
      new Vector3(1, 0, 0),
      SPAWN_TILT_RAD,
    );

    /**
     * Spawn one capsule bone: a dynamic rigid body + matching Three mesh, placed
     * at the spawn pose (pelvis at SPAWN_Y, leaning forward). Reused by both the
     * initial build and respawn.
     */
    const spawnBone = (
      spec: BoneSpec,
    ): { rb: RAPIER.RigidBody; mesh: Mesh } => {
      if (!world) throw new Error("spawnBone before world init");
      // Rotate the bone's local offset by the spawn lean, then translate so the
      // whole figure tilts as one rigid pose at spawn.
      const local = new Vector3(...spec.offset).applyQuaternion(spawnQuat);
      const rb = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(local.x, SPAWN_Y + local.y, local.z)
          .setRotation(spawnQuat)
          .setLinearDamping(BONE_LINEAR_DAMPING)
          .setAngularDamping(BONE_ANGULAR_DAMPING),
      );
      // Capsule collider: Rapier takes the cylinder half-height + cap radius.
      world.createCollider(
        RAPIER.ColliderDesc.capsule(spec.halfHeight, spec.radius).setDensity(
          BONE_DENSITY,
        ),
        rb,
      );

      let geo = boneGeometries.get(spec.name);
      if (!geo) {
        // Three CapsuleGeometry(radius, length) where length is the cylinder part
        // (= 2 * halfHeight), matching the Rapier capsule's straight section.
        geo = new CapsuleGeometry(spec.radius, spec.halfHeight * 2);
        boneGeometries.set(spec.name, geo);
      }
      const mesh = new Mesh(geo, boneMaterial);
      scene.add(mesh);
      boneMeshes.push(mesh);
      return { rb, mesh };
    };

    /** Tear down the current ragdoll bodies + meshes (used by respawn). */
    const clearRagdoll = (): void => {
      if (!world || !bones) return;
      for (const { rb, mesh } of bones.values()) {
        world.removeRigidBody(rb); // also removes its colliders + joints
        scene.remove(mesh);
      }
      // Geometries/material are reused across respawns; freed only on dispose.
      bones = null;
      boneMeshes.length = 0;
    };

    /** (Re)build the ragdoll at the spawn pose so it drops and flops anew. */
    const dropRagdoll = (): void => {
      if (!world) return;
      clearRagdoll();
      bones = buildRagdoll(world, spawnBone).bones;
    };

    // Rapier's -compat build must be initialised (WASM) before use. Build the
    // world only after init resolves, and bail if the sample was disposed first.
    void RAPIER.init().then(() => {
      if (disposed) return;
      world = new RAPIER.World(new RAPIER.Vector3(0, GRAVITY_Y, 0));

      // Static floor.
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(FLOOR_HALF, FLOOR_THICKNESS, FLOOR_HALF),
        world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(
            0,
            GROUND_Y - FLOOR_THICKNESS,
            0,
          ),
        ),
      );

      dropRagdoll();
      raf = requestAnimationFrame(step);
    });

    // --- Per-frame timing. ---
    let last = performance.now();
    let accumulator = 0;

    const step = (now: number): void => {
      raf = requestAnimationFrame(step);
      if (!world) return; // guard: never step after dispose freed the world

      const frameDt = Math.min((now - last) / 1000, MAX_FRAME_DT);
      last = now;
      hud.frame(now);

      if (respawnRequested) {
        respawnRequested = false;
        dropRagdoll();
      }

      // Fixed-timestep accumulator for stable joints.
      accumulator += frameDt;
      let substeps = 0;
      while (accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS) {
        world.step();
        accumulator -= FIXED_DT;
        substeps++;
      }
      if (substeps >= MAX_SUBSTEPS) accumulator = 0; // drop backlog after a stall

      // Sync each bone mesh from its physics body.
      if (bones) {
        for (const { mesh, rb } of bones.values()) {
          const t = rb.translation();
          const r = rb.rotation();
          mesh.position.set(t.x, t.y, t.z);
          mesh.quaternion.set(r.x, r.y, r.z, r.w);
        }
      }
    };

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("click", onClick);
      hud.dispose();

      // Free the physics world (also frees its bodies/colliders/joints). After
      // this no stepping runs because raf is cancelled and the loop guards on
      // `world` (set null below) — prevents any use-after-free.
      world?.free();
      world = null;
      bones = null;

      // Free every geometry + material this sample created.
      for (const geo of boneGeometries.values()) geo.dispose();
      boneGeometries.clear();
      boneMaterial.dispose();
      for (const mesh of boneMeshes) scene.remove(mesh);
      boneMeshes.length = 0;

      // Stage primitives free their own GPU resources.
      lights.dispose();
      ground.dispose();
    };
  },
};

export default sample;
