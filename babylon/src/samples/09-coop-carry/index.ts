import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { FollowCamera } from "@babylonjs/core/Cameras/followCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType, PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { BallAndSocketConstraint } from "@babylonjs/core/Physics/v2/physicsConstraint";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Meshes/Builders/cylinderBuilder";
import "@babylonjs/core/Physics/physicsEngineComponent";

import { getHavokPlugin } from "../../engine/havok";
import { createInput } from "../../engine/input";
import { createHud } from "../../engine/hud";
import { createGround, createLightPreset } from "../../engine/scene";
import type { Sample, SampleContext } from "../types";

// --- Stage. ---
const GROUND_SIZE = 60;

// --- Carriers (two kinematic/ANIMATED posts the plank hangs from). ---
// Carrier A is driven by the player; carrier B auto-follows A at a fixed side
// offset. Both are ANIMATED bodies: we move them by setting a target transform
// each frame and they drag the jointed plank WITHOUT being pushed back or
// toppling (an ANIMATED body is not affected by collisions/constraints).
const CARRIER_RADIUS = 0.35;
const CARRIER_HEIGHT = 1.8;
const CARRIER_CARRY_Y = 1.6; // world height of the carry point (top of the post)
const CARRIER_A_COLOR = new Color3(0.29, 0.64, 1);
const CARRIER_B_COLOR = new Color3(1, 0.62, 0.29);
const CARRIER_MOVE_SPEED = 4.5; // units/s for carrier A
// Carrier B lags carrier A: its target eases toward A's position plus the carry
// span on A's right. The follow gain is deliberately soft so B trails when A
// turns or accelerates — that lag is what makes the plank sway (the co-op feel).
const CARRIER_B_FOLLOW_GAIN = 6;
const CARRY_SPAN = 3; // distance between the two carry points (≈ plank length)

// --- Plank (the DYNAMIC object being carried). ---
const PLANK_LENGTH = 3.2;
const PLANK_THICK = 0.18;
const PLANK_WIDTH = 0.5;
const PLANK_COLOR = new Color3(0.79, 0.64, 0.42);
const PLANK_MASS = 2; // light-ish wood so the carriers can lift it via the joints
const PLANK_START_Y = CARRIER_CARRY_Y; // spawned at carry height between carriers

// --- Camera (third-person follow, behind carrier A). ---
const CAMERA_RADIUS = 9;
const CAMERA_HEIGHT = 4;
const CAMERA_ACCEL = 0.08;
const CAMERA_MAX_SPEED = 20;
const LOOK_SENSITIVITY = 0.0025;

// --- Tilt readout placement (below the gallery's top-left card). ---
const STATUS_TOP_PX = "64px";
const STATUS_LEFT_PX = "12px";

function sample09Mount(ctx: SampleContext): () => void {
  const { scene, canvas } = ctx;
  scene.clearColor.set(0.05, 0.06, 0.08, 1);

  let disposed = false;
  const cleanups: Array<() => void> = [];

  // --- Lighting + ground (scene-owned; freed by scene.dispose). ---
  createLightPreset(scene);
  createGround(scene, { size: GROUND_SIZE, color: new Color3(0.18, 0.2, 0.24) });

  // --- Materials (owned by this sample; disposed below). ---
  const carrierAMat = new StandardMaterial("coopCarrierAMat", scene);
  carrierAMat.diffuseColor = CARRIER_A_COLOR.clone();
  const carrierBMat = new StandardMaterial("coopCarrierBMat", scene);
  carrierBMat.diffuseColor = CARRIER_B_COLOR.clone();
  const plankMat = new StandardMaterial("coopPlankMat", scene);
  plankMat.diffuseColor = PLANK_COLOR.clone();

  // --- Carrier meshes (visual posts). ---
  const makeCarrierMesh = (name: string, mat: StandardMaterial): Mesh => {
    const m = MeshBuilder.CreateCylinder(
      name,
      { diameter: CARRIER_RADIUS * 2, height: CARRIER_HEIGHT },
      scene,
    );
    m.material = mat;
    return m;
  };
  const carrierAMesh = makeCarrierMesh("coopCarrierA", carrierAMat);
  const carrierBMesh = makeCarrierMesh("coopCarrierB", carrierBMat);

  // --- Plank mesh. ---
  const plankMesh = MeshBuilder.CreateBox(
    "coopPlank",
    { width: PLANK_LENGTH, height: PLANK_THICK, depth: PLANK_WIDTH },
    scene,
  );
  plankMesh.material = plankMat;

  // Start poses (also used by reset). Carrier center sits at half-height so its
  // bottom rests on the ground; the carry point is at CARRIER_CARRY_Y.
  const startA = new Vector3(-CARRY_SPAN / 2, CARRIER_HEIGHT / 2, 0);
  const startB = new Vector3(CARRY_SPAN / 2, CARRIER_HEIGHT / 2, 0);
  const startPlank = new Vector3(0, PLANK_START_Y, 0);
  carrierAMesh.position.copyFrom(startA);
  carrierBMesh.position.copyFrom(startB);
  plankMesh.position.copyFrom(startPlank);

  // --- Follow camera trails carrier A. ---
  const camera = new FollowCamera(
    "coopFollowCam",
    new Vector3(0, CAMERA_HEIGHT, -CAMERA_RADIUS),
    scene,
    carrierAMesh,
  );
  camera.radius = CAMERA_RADIUS;
  camera.heightOffset = CAMERA_HEIGHT;
  camera.rotationOffset = 180;
  camera.cameraAcceleration = CAMERA_ACCEL;
  camera.maxCameraSpeed = CAMERA_MAX_SPEED;

  // --- HUD + tilt readout. ---
  const hud = createHud(ctx, {
    title: "Co-op Carry",
    controls: [
      "WASD — drive carrier A",
      "Mouse — look (click to lock pointer)",
      "Space — drop / re-attach the plank",
      "R — reset",
      "Esc — release pointer",
    ],
  });

  const status = document.createElement("div");
  Object.assign(status.style, {
    position: "absolute",
    top: STATUS_TOP_PX,
    left: STATUS_LEFT_PX,
    padding: "8px 10px",
    borderRadius: "8px",
    background: "rgba(11, 14, 19, 0.72)",
    border: "1px solid rgba(74, 163, 255, 0.25)",
    color: "#e6edf3",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "13px",
    lineHeight: "1.6",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    zIndex: "10",
  } as Partial<CSSStyleDeclaration>);
  const statusContainer = canvas.parentElement ?? document.body;
  statusContainer.appendChild(status);
  cleanups.push(() => status.remove());

  // --- Input (shared module: keyboard state + pointer-lock look). ---
  const input = createInput(ctx);
  cleanups.push(() => input.dispose());
  cleanups.push(() => hud.dispose());

  // Async because Havok WASM loads on demand. Guard with `disposed` so a fast
  // sample switch during the await never builds the world or starts updating.
  void getHavokPlugin().then((plugin) => {
    if (disposed) return;
    scene.enablePhysics(new Vector3(0, -9.81, 0), plugin);

    // Static floor collider so the dropped plank lands on something.
    const floor = MeshBuilder.CreateGround(
      "coopFloorCollider",
      { width: GROUND_SIZE, height: GROUND_SIZE },
      scene,
    );
    floor.isVisible = false;
    new PhysicsAggregate(floor, PhysicsShapeType.BOX, { mass: 0 }, scene);

    // Carriers: ANIMATED bodies. They drag the jointed plank but ignore the
    // reaction, so they stay exactly where we put them (upright by construction).
    const carrierAggA = new PhysicsAggregate(
      carrierAMesh,
      PhysicsShapeType.CYLINDER,
      { mass: 1 },
      scene,
    );
    const carrierAggB = new PhysicsAggregate(
      carrierBMesh,
      PhysicsShapeType.CYLINDER,
      { mass: 1 },
      scene,
    );
    carrierAggA.body.setMotionType(PhysicsMotionType.ANIMATED);
    carrierAggB.body.setMotionType(PhysicsMotionType.ANIMATED);

    // Plank: DYNAMIC (mass > 0) so it swings/tilts under inertia.
    const plankAgg = new PhysicsAggregate(
      plankMesh,
      PhysicsShapeType.BOX,
      { mass: PLANK_MASS, restitution: 0.1, friction: 0.6 },
      scene,
    );

    // The two ball-and-socket constraints attaching the plank ends to the
    // carriers. Non-null only while attached; dropping disposes them, re-attach
    // recreates them.
    let constraintA: BallAndSocketConstraint | null = null;
    let constraintB: BallAndSocketConstraint | null = null;
    let attached = false;

    // Local-frame anchors. The plank's local +X is its length axis, so its ends
    // are at ±LENGTH/2. The carrier's carry point is at the top of the post.
    const plankAnchorA = new Vector3(-PLANK_LENGTH / 2, 0, 0);
    const plankAnchorB = new Vector3(PLANK_LENGTH / 2, 0, 0);
    const carrierTop = new Vector3(0, CARRIER_CARRY_Y - CARRIER_HEIGHT / 2, 0);
    const axis = new Vector3(0, 1, 0); // ball-and-socket leaves rotation free

    const attach = (): void => {
      if (attached) return;
      // BallAndSocketConstraint(pivotA, pivotB, axisA, axisB, scene): pivotA is
      // in body A's (plank) local frame, pivotB in body B's (carrier) frame.
      constraintA = new BallAndSocketConstraint(
        plankAnchorA,
        carrierTop,
        axis,
        axis,
        scene,
      );
      constraintB = new BallAndSocketConstraint(
        plankAnchorB,
        carrierTop,
        axis,
        axis,
        scene,
      );
      plankAgg.body.addConstraint(carrierAggA.body, constraintA);
      plankAgg.body.addConstraint(carrierAggB.body, constraintB);
      attached = true;
    };

    const detach = (): void => {
      if (!attached) return;
      // Disposing the constraint removes it from the engine; the plank becomes a
      // free dynamic body and falls.
      constraintA?.dispose();
      constraintB?.dispose();
      constraintA = null;
      constraintB = null;
      attached = false;
    };

    const upright = Quaternion.Identity();

    // --- Driving state. ---
    // Carrier A is steered like sample 01's controller: a yaw heading driven by
    // pointer-lock look, WASD producing a world-space move on that basis. We move
    // the ANIMATED bodies via setTargetTransform so they pull the plank's joints.
    // `aTarget`/`bTarget` are the carriers' running target positions; reset()
    // rewinds them so the update loop doesn't immediately snap the carriers back.
    let yaw = 0;
    const aTarget = startA.clone();
    const bTarget = startB.clone();
    let prevSpace = false;
    let prevR = false;
    // After a reset we set the plank's disablePreStep=false for ONE prestep so
    // the teleported transform is read into physics; the next frame restores the
    // default (true) so the dynamic simulation drives the transform again.
    let restorePlankPreStep = false;

    const reset = (): void => {
      detach();

      // Rewind the driving targets so the next update frame keeps the start pose.
      aTarget.copyFrom(startA);
      bTarget.copyFrom(startB);

      // Carriers are ANIMATED: setTargetTransform aims their velocity, so also
      // teleport the transform + zero velocity for an instant, clean reset.
      carrierAMesh.position.copyFrom(startA);
      carrierAggA.body.setTargetTransform(startA.clone(), upright.clone());
      carrierAggA.body.setLinearVelocity(Vector3.Zero());
      carrierAggA.body.setAngularVelocity(Vector3.Zero());

      carrierBMesh.position.copyFrom(startB);
      carrierAggB.body.setTargetTransform(startB.clone(), upright.clone());
      carrierAggB.body.setLinearVelocity(Vector3.Zero());
      carrierAggB.body.setAngularVelocity(Vector3.Zero());

      // Reset the DYNAMIC plank to its start pose at rest. Teleport a dynamic
      // body by writing its transform node + disablePreStep=false so the engine
      // reads the new pose on the next prestep, then clear residual velocity.
      plankMesh.position.copyFrom(startPlank);
      if (!plankMesh.rotationQuaternion) {
        plankMesh.rotationQuaternion = Quaternion.Identity();
      } else {
        plankMesh.rotationQuaternion.copyFrom(upright);
      }
      plankAgg.body.disablePreStep = false;
      restorePlankPreStep = true;
      plankAgg.body.setLinearVelocity(Vector3.Zero());
      plankAgg.body.setAngularVelocity(Vector3.Zero());

      attach();
    };

    // Initial grab.
    attach();

    const update = (): void => {
      const dt = scene.getEngine().getDeltaTime() / 1000;
      if (dt <= 0) return;

      // Edge-triggered Space (drop / re-attach) and R (reset).
      const spaceDown = input.isKeyDown("Space");
      if (spaceDown && !prevSpace) {
        if (attached) detach();
        else attach();
      }
      prevSpace = spaceDown;

      const rDown = input.isKeyDown("KeyR");
      if (rDown && !prevR) reset();
      prevR = rDown;

      // Restore the plank's default prestep one frame after a reset teleport so
      // the dynamic simulation drives its transform again (and it can swing).
      if (restorePlankPreStep) {
        plankAgg.body.disablePreStep = true;
        restorePlankPreStep = false;
      }

      // Apply look to the yaw heading.
      yaw += input.consumeLookX() * LOOK_SENSITIVITY;

      // Build a movement vector in carrier A's local frame, then rotate by yaw.
      // Same basis as sample 01: worldX = strafe·cos + forward·sin, worldZ =
      // forward·cos − strafe·sin.
      let forward = 0;
      let strafe = 0;
      if (input.isKeyDown("KeyW")) forward += 1;
      if (input.isKeyDown("KeyS")) forward -= 1;
      if (input.isKeyDown("KeyD")) strafe += 1;
      if (input.isKeyDown("KeyA")) strafe -= 1;

      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      if (forward !== 0 || strafe !== 0) {
        const len = Math.hypot(forward, strafe);
        forward /= len;
        strafe /= len;
        aTarget.x += (strafe * cos + forward * sin) * CARRIER_MOVE_SPEED * dt;
        aTarget.z += (forward * cos - strafe * sin) * CARRIER_MOVE_SPEED * dt;
      }
      aTarget.y = CARRIER_HEIGHT / 2;
      carrierAggA.body.setTargetTransform(aTarget, upright);

      // Carrier B follows A at a fixed side offset on A's right (+X local). A
      // soft P-controller eases B's target toward that point, so B trails when A
      // turns/accelerates — the lag is the co-op sway.
      const rightX = cos; // A's right axis = (cos, 0, -sin)
      const rightZ = -sin;
      const desiredBX = aTarget.x + rightX * CARRY_SPAN;
      const desiredBZ = aTarget.z + rightZ * CARRY_SPAN;
      // Exponential approach: factor clamped to [0,1] keeps it stable at any dt.
      const follow = Math.min(1, CARRIER_B_FOLLOW_GAIN * dt);
      bTarget.x += (desiredBX - bTarget.x) * follow;
      bTarget.z += (desiredBZ - bTarget.z) * follow;
      bTarget.y = CARRIER_HEIGHT / 2;
      carrierAggB.body.setTargetTransform(bTarget, upright);

      // Tilt readout: the plank's local +X is its length axis. Rotate it by the
      // body's orientation and read the world-Y component (= sin of the tilt off
      // horizontal). Makes the sway legible as a number.
      let tiltDeg = 0;
      const q = plankMesh.rotationQuaternion;
      if (q) {
        const ay = 2 * (q.x * q.y + q.w * q.z); // y of rotated (1,0,0)
        tiltDeg = Math.abs(
          (Math.asin(Math.max(-1, Math.min(1, ay))) * 180) / Math.PI,
        );
      }
      const label = attached ? "CARRIED" : "DROPPED";
      const color = attached ? "#5fd97a" : "#ff6b61";
      status.innerHTML =
        `Plank: <span style="color:${color};font-weight:600">${label}</span>` +
        ` · tilt ${tiltDeg.toFixed(0)}°`;
    };

    const updateObserver = scene.onBeforeRenderObservable.add(update);
    cleanups.push(() => {
      scene.onBeforeRenderObservable.remove(updateObserver);
      // Dispose constraints first, then the physics aggregates we created.
      detach();
      plankAgg.dispose();
      carrierAggA.dispose();
      carrierAggB.dispose();
    });
  });

  return () => {
    disposed = true;
    for (const c of cleanups) c();
    carrierAMat.dispose();
    carrierBMat.dispose();
    plankMat.dispose();
  };
}

export const sample09: Sample = {
  id: "09-coop-carry",
  title: "Co-op Carry (Havok joints)",
  summary:
    "Carry a dynamic plank jointed to two carrier posts with ball-and-socket constraints. Drive carrier A; carrier B lags, so the plank sways and tilts. Space to drop / re-attach.",
  tags: ["physics", "havok", "joints", "co-op"],
  mount: sample09Mount,
};

export default sample09;
