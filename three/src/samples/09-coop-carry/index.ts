import RAPIER from "@dimforge/rapier3d-compat";
import {
  BoxGeometry,
  CylinderGeometry,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from "three";
import { Hud } from "../../engine/hud";
import { InputController } from "../../engine/input";
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

// --- Carriers (two velocity-controlled dynamic posts the plank hangs from). ---
// Carrier A is driven by the player; carrier B auto-follows A at a fixed side
// offset. Both are dynamic bodies steered by setting their linear velocity each
// physics step (velocity control), so the jointed plank reacts to their motion.
const CARRIER_RADIUS = 0.35;
const CARRIER_HEIGHT = 1.8;
const CARRIER_SEGMENTS = 16;
const CARRIER_CARRY_Y = 1.6; // height of the carry point (top of the post)
const CARRIER_A_COLOR = 0x4aa3ff;
const CARRIER_B_COLOR = 0xff9d4a;
const CARRIER_MOVE_SPEED = 4.5; // m/s target speed for carrier A
const CARRIER_VEL_GAIN = 10; // how hard a carrier is steered toward its target velocity
// Carrier B lags carrier A: it steers toward A's position plus the carry span
// on A's right. The follow gain is deliberately soft so B trails when A turns
// or accelerates — that lag is what makes the plank sway (the "co-op" feel).
const CARRIER_B_FOLLOW_GAIN = 6;
const CARRY_SPAN = 3; // distance between the two carry points (plank length-ish)

// --- Plank (the dynamic object being carried). ---
const PLANK_LENGTH = 3.2;
const PLANK_THICK = 0.18;
const PLANK_WIDTH = 0.5;
const PLANK_COLOR = 0xc9a36a;
const PLANK_DENSITY = 0.6; // light-ish wood so the carriers can lift it
const PLANK_START_Y = CARRIER_CARRY_Y; // spawned at carry height between carriers

// --- Camera (third-person follow, behind carrier A). ---
const CAMERA_DISTANCE = 9;
const CAMERA_HEIGHT = 5;
const CAMERA_LOOK_HEIGHT = 1.2;
const INITIAL_PITCH = 0.32;
const PITCH_CLAMP: [number, number] = [-0.2, 1.2];
const START_YAW = 0; // yaw 0 looks down -Z

// --- Obstacle posts: give the carry a reason to coordinate (thread between them). ---
const OBSTACLE_COUNT = 4;
const OBSTACLE_RADIUS = 0.4;
const OBSTACLE_HEIGHT = 2.4;
const OBSTACLE_SEGMENTS = 12;
const OBSTACLE_COLOR = 0x556070;
const OBSTACLE_GAP = 5; // spacing of the slalom posts along -Z
const OBSTACLE_FIRST_Z = -6;
const OBSTACLE_SIDE_X = 1.4; // posts alternate left/right of the path

/** A Three mesh paired with the Rapier body that drives it. */
interface PhysicsBody {
  mesh: Mesh;
  rb: RAPIER.RigidBody;
}

const sample: Sample = {
  id: "09-coop-carry",
  title: "Co-op Carry",
  summary:
    "Carry a dynamic plank jointed to two carriers. You drive carrier A; carrier B follows. Move out of sync and the plank sways and tilts. Space to pick up / drop.",
  tags: ["physics", "rapier", "joints", "co-op"],

  mount(ctx: SampleContext): () => void {
    const { scene, camera, canvas } = ctx;

    const lights = createLightPreset(scene, { background: SCENE_BACKGROUND });
    const ground = createGround(scene, { size: FLOOR_HALF * 2 });

    const input = new InputController({
      pointerLockTarget: canvas,
      initialYaw: START_YAW,
      initialPitch: INITIAL_PITCH,
      pitchClamp: PITCH_CLAMP,
    });

    const hud = new Hud({
      container: canvas.parentElement ?? undefined,
      title: "Co-op Carry",
      controls: [
        "Click canvas — lock mouse",
        "WASD — drive carrier A",
        "Mouse — orbit camera",
        "Space — pick up / drop the plank",
        "R — reset",
      ],
    });

    // Carry-state readout (top-left, below the gallery card).
    const status = document.createElement("div");
    Object.assign(status.style, {
      position: "absolute",
      top: "64px",
      left: "12px",
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
    (canvas.parentElement ?? document.body).appendChild(status);

    // --- Mesh resources (tracked for disposal). ---
    const carrierGeo = new CylinderGeometry(
      CARRIER_RADIUS,
      CARRIER_RADIUS,
      CARRIER_HEIGHT,
      CARRIER_SEGMENTS,
    );
    const carrierAMat = new MeshStandardMaterial({ color: CARRIER_A_COLOR });
    const carrierBMat = new MeshStandardMaterial({ color: CARRIER_B_COLOR });
    const plankGeo = new BoxGeometry(PLANK_LENGTH, PLANK_THICK, PLANK_WIDTH);
    const plankMat = new MeshStandardMaterial({ color: PLANK_COLOR });
    const obstacleGeo = new CylinderGeometry(
      OBSTACLE_RADIUS,
      OBSTACLE_RADIUS,
      OBSTACLE_HEIGHT,
      OBSTACLE_SEGMENTS,
    );
    const obstacleMat = new MeshStandardMaterial({ color: OBSTACLE_COLOR });

    const carrierAMesh = new Mesh(carrierGeo, carrierAMat);
    const carrierBMesh = new Mesh(carrierGeo, carrierBMat);
    const plankMesh = new Mesh(plankGeo, plankMat);
    scene.add(carrierAMesh, carrierBMesh, plankMesh);

    const obstacleMeshes: Mesh[] = [];
    for (let i = 0; i < OBSTACLE_COUNT; i++) {
      const m = new Mesh(obstacleGeo, obstacleMat);
      const side = i % 2 === 0 ? -1 : 1;
      m.position.set(
        side * OBSTACLE_SIDE_X,
        GROUND_Y + OBSTACLE_HEIGHT / 2,
        OBSTACLE_FIRST_Z - i * OBSTACLE_GAP,
      );
      scene.add(m);
      obstacleMeshes.push(m);
    }

    // --- Physics state (built after async Rapier init). ---
    let disposed = false;
    let raf = 0;
    let world: RAPIER.World | null = null;
    let carrierA: RAPIER.RigidBody | null = null;
    let carrierB: RAPIER.RigidBody | null = null;
    let plank: PhysicsBody | null = null;
    // The two joints attaching the plank ends to the carriers. Non-null only
    // while the plank is "carried"; dropping removes them, picking up recreates.
    let jointA: RAPIER.ImpulseJoint | null = null;
    let jointB: RAPIER.ImpulseJoint | null = null;
    let carried = false;

    // Spawn positions (also used by reset).
    const startA = new RAPIER.Vector3(-CARRY_SPAN / 2, CARRIER_HEIGHT / 2, 0);
    const startB = new RAPIER.Vector3(CARRY_SPAN / 2, CARRIER_HEIGHT / 2, 0);

    /** Attach the plank's two ends to the carriers with spherical joints. */
    const attachJoints = (): void => {
      if (!world || !carrierA || !carrierB || !plank) return;
      // Spherical joints pin a point on the plank to a point on each carrier but
      // leave rotation free, so the plank can swing and tilt as the carriers
      // move out of sync — exactly the sway we want to read.
      const plankAnchorA = new RAPIER.Vector3(-PLANK_LENGTH / 2, 0, 0);
      const plankAnchorB = new RAPIER.Vector3(PLANK_LENGTH / 2, 0, 0);
      const carrierTop = new RAPIER.Vector3(
        0,
        CARRIER_CARRY_Y - CARRIER_HEIGHT / 2,
        0,
      );
      jointA = world.createImpulseJoint(
        RAPIER.JointData.spherical(plankAnchorA, carrierTop),
        plank.rb,
        carrierA,
        true,
      );
      jointB = world.createImpulseJoint(
        RAPIER.JointData.spherical(plankAnchorB, carrierTop),
        plank.rb,
        carrierB,
        true,
      );
      carried = true;
    };

    /** Remove the carry joints (drop the plank). */
    const detachJoints = (): void => {
      if (!world) return;
      if (jointA) world.removeImpulseJoint(jointA, true);
      if (jointB) world.removeImpulseJoint(jointB, true);
      jointA = null;
      jointB = null;
      carried = false;
    };

    /** Reset carriers and plank to their start poses and re-grab. */
    const reset = (): void => {
      if (!world || !carrierA || !carrierB || !plank) return;
      detachJoints();
      const zeroVel = new RAPIER.Vector3(0, 0, 0);
      const upright = new RAPIER.Quaternion(0, 0, 0, 1);

      carrierA.setTranslation(startA, true);
      carrierA.setLinvel(zeroVel, true);
      carrierA.setAngvel(zeroVel, true);
      carrierA.setRotation(upright, true);

      carrierB.setTranslation(startB, true);
      carrierB.setLinvel(zeroVel, true);
      carrierB.setAngvel(zeroVel, true);
      carrierB.setRotation(upright, true);

      plank.rb.setTranslation(new RAPIER.Vector3(0, PLANK_START_Y, 0), true);
      plank.rb.setLinvel(zeroVel, true);
      plank.rb.setAngvel(zeroVel, true);
      plank.rb.setRotation(upright, true);

      attachJoints();
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

      // Static obstacle posts (collide with the plank so threading them matters).
      for (const m of obstacleMeshes) {
        const body = world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(
            m.position.x,
            m.position.y,
            m.position.z,
          ),
        );
        world.createCollider(
          RAPIER.ColliderDesc.cylinder(OBSTACLE_HEIGHT / 2, OBSTACLE_RADIUS),
          body,
        );
      }

      // Carriers: dynamic bodies whose rotation is locked (they stay upright)
      // and which are steered by velocity each step. Locking rotation keeps the
      // carry points stable so the plank's swing comes from translation lag, not
      // the posts toppling.
      const makeCarrier = (start: RAPIER.Vector3): RAPIER.RigidBody => {
        const rb = world!.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(start.x, start.y, start.z)
            .lockRotations()
            .setLinearDamping(1.5),
        );
        world!.createCollider(
          RAPIER.ColliderDesc.capsule(
            CARRIER_HEIGHT / 2 - CARRIER_RADIUS,
            CARRIER_RADIUS,
          ),
          rb,
        );
        return rb;
      };
      carrierA = makeCarrier(startA);
      carrierB = makeCarrier(startB);

      // Plank: the dynamic carried object.
      const plankRb = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(0, PLANK_START_Y, 0),
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(
          PLANK_LENGTH / 2,
          PLANK_THICK / 2,
          PLANK_WIDTH / 2,
        ).setDensity(PLANK_DENSITY),
        plankRb,
      );
      plank = { mesh: plankMesh, rb: plankRb };

      attachJoints();

      raf = requestAnimationFrame(step);
    });

    // --- Per-frame scratch. ---
    let last = performance.now();
    let accumulator = 0;
    const forward = new Vector3();
    const right = new Vector3();
    const moveDir = new Vector3();
    const camOffset = new Vector3();
    const followTarget = new Vector3();

    /** Advance physics by one fixed step: steer carriers, then world.step(). */
    const fixedStep = (): void => {
      if (!world || !carrierA || !carrierB) return;

      const yaw = input.yaw;
      // Camera-consistent basis: yaw 0 looks down -Z.
      forward.set(-Math.sin(yaw), 0, -Math.cos(yaw)).normalize();
      right.set(forward.z, 0, -forward.x);

      // Player drives carrier A by velocity.
      moveDir.set(0, 0, 0);
      if (input.isDown("KeyW")) moveDir.add(forward);
      if (input.isDown("KeyS")) moveDir.sub(forward);
      if (input.isDown("KeyA")) moveDir.add(right);
      if (input.isDown("KeyD")) moveDir.sub(right);

      const aPos = carrierA.translation();
      if (moveDir.lengthSq() > 0) {
        moveDir.normalize().multiplyScalar(CARRIER_MOVE_SPEED);
      }
      // Steer A toward the desired horizontal velocity (gain shapes the ramp);
      // vertical velocity is left to physics so it rests on the floor.
      const aVel = carrierA.linvel();
      carrierA.setLinvel(
        new RAPIER.Vector3(
          aVel.x + (moveDir.x - aVel.x) * CARRIER_VEL_GAIN * FIXED_DT,
          aVel.y,
          aVel.z + (moveDir.z - aVel.z) * CARRIER_VEL_GAIN * FIXED_DT,
        ),
        true,
      );

      // Carrier B follows A at a fixed side offset (A's right). The follow is
      // soft, so B trails when A turns/accelerates — the lag is the co-op sway.
      followTarget.set(
        aPos.x + right.x * CARRY_SPAN,
        aPos.y,
        aPos.z + right.z * CARRY_SPAN,
      );
      const bPos = carrierB.translation();
      const bVel = carrierB.linvel();
      // Desired velocity = position error * follow gain (a soft P-controller).
      const desiredVx = (followTarget.x - bPos.x) * CARRIER_B_FOLLOW_GAIN;
      const desiredVz = (followTarget.z - bPos.z) * CARRIER_B_FOLLOW_GAIN;
      carrierB.setLinvel(
        new RAPIER.Vector3(
          bVel.x + (desiredVx - bVel.x) * CARRIER_VEL_GAIN * FIXED_DT,
          bVel.y,
          bVel.z + (desiredVz - bVel.z) * CARRIER_VEL_GAIN * FIXED_DT,
        ),
        true,
      );

      world.step();
    };

    const step = (now: number): void => {
      raf = requestAnimationFrame(step);
      if (!world) return;

      const frameDt = Math.min((now - last) / 1000, MAX_FRAME_DT);
      last = now;
      hud.frame(now);

      if (input.consumeJustPressed("KeyR")) reset();
      if (input.consumeJustPressed("Space")) {
        if (carried) detachJoints();
        else attachJoints();
      }

      // Fixed-timestep accumulator for stable joints.
      accumulator += frameDt;
      let substeps = 0;
      while (accumulator >= FIXED_DT && substeps < MAX_SUBSTEPS) {
        fixedStep();
        accumulator -= FIXED_DT;
        substeps++;
      }
      if (substeps >= MAX_SUBSTEPS) accumulator = 0; // drop backlog after a stall

      // Sync meshes from physics bodies.
      if (carrierA) {
        const t = carrierA.translation();
        const r = carrierA.rotation();
        carrierAMesh.position.set(t.x, t.y, t.z);
        carrierAMesh.quaternion.set(r.x, r.y, r.z, r.w);
      }
      if (carrierB) {
        const t = carrierB.translation();
        const r = carrierB.rotation();
        carrierBMesh.position.set(t.x, t.y, t.z);
        carrierBMesh.quaternion.set(r.x, r.y, r.z, r.w);
      }
      if (plank) {
        const t = plank.rb.translation();
        const r = plank.rb.rotation();
        plankMesh.position.set(t.x, t.y, t.z);
        plankMesh.quaternion.set(r.x, r.y, r.z, r.w);
      }

      // Follow camera behind carrier A (spherical offset from yaw/pitch).
      if (carrierA) {
        const a = carrierA.translation();
        const yaw = input.yaw;
        const pitch = input.pitch;
        camOffset
          .set(
            Math.sin(yaw) * Math.cos(pitch),
            Math.sin(pitch),
            Math.cos(yaw) * Math.cos(pitch),
          )
          .multiplyScalar(CAMERA_DISTANCE);
        camera.position.set(
          a.x + camOffset.x,
          a.y + camOffset.y,
          a.z + camOffset.z,
        );
        camera.position.y += CAMERA_HEIGHT * Math.cos(pitch);
        camera.lookAt(a.x, a.y + CAMERA_LOOK_HEIGHT, a.z);
      }

      // Carry-state readout: tilt magnitude makes the sway legible as a number.
      let tiltDeg = 0;
      if (plank) {
        // Plank's local +X is its length axis; measure how far it deviates from
        // horizontal by rotating local X by the body quaternion and reading the
        // world-Y component (= sin of the tilt angle).
        const q = plank.rb.rotation();
        const ay = 2 * (q.x * q.y + q.w * q.z); // y of rotated (1,0,0)
        tiltDeg = Math.abs(
          Math.asin(Math.max(-1, Math.min(1, ay))) * (180 / Math.PI),
        );
      }
      const carryLabel = carried ? "CARRIED" : "DROPPED";
      const carryColor = carried ? "#5fd97a" : "#ff6b61";
      status.innerHTML =
        `Plank: <span style="color:${carryColor};font-weight:600">${carryLabel}</span>` +
        ` · tilt ${tiltDeg.toFixed(0)}deg`;
    };

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      input.dispose();
      hud.dispose();
      status.remove();

      // Free the physics world (also frees its bodies/colliders/joints). After
      // this no stepping runs because raf is cancelled and the loop guards on
      // `world` (set null below).
      world?.free();
      world = null;
      carrierA = null;
      carrierB = null;
      plank = null;
      jointA = null;
      jointB = null;

      // Free every geometry + material this sample created.
      carrierGeo.dispose();
      carrierAMat.dispose();
      carrierBMat.dispose();
      plankGeo.dispose();
      plankMat.dispose();
      obstacleGeo.dispose();
      obstacleMat.dispose();
      scene.remove(carrierAMesh, carrierBMesh, plankMesh);
      for (const m of obstacleMeshes) scene.remove(m);

      // Stage primitives free their own GPU resources.
      lights.dispose();
      ground.dispose();
    };
  },
};

export default sample;
