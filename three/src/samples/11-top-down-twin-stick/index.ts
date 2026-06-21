import {
  ConeGeometry,
  CylinderGeometry,
  Mesh,
  MeshStandardMaterial,
  Plane,
  Raycaster,
  RingGeometry,
  Vector2,
  Vector3,
} from "three";
import { Hud } from "../../engine/hud";
import { InputController } from "../../engine/input";
import {
  createBoxGrid,
  createGround,
  createLightPreset,
} from "../../engine/scene";
import type { Sample, SampleContext } from "../types";

// --- Movement tuning (no magic numbers in the logic below). ---
const MOVE_SPEED = 7; // m/s, world-axis WASD
const GROUND_Y = 0;
const SCENE_BACKGROUND = 0x0d1117;
const START_X = 0;
const START_Z = 0;
const GRID_COUNT = 4;
const GRID_SPACING = 5;

// --- Top-down camera. Slightly tilted (not pure ortho-top) so the player's
// nose and the box grid read with a little depth. Camera follows the player's
// XZ position at a fixed height/offset; it never rotates with aim. ---
const CAMERA_HEIGHT = 18; // meters above the player
const CAMERA_BACK = 6; // meters behind (+Z) the player for the slight tilt
const CAMERA_LOOK_HEIGHT = 0; // look at the ground plane under the player

// --- Player rig (a disc body + a nose cone so facing is unambiguous). ---
const BODY_RADIUS = 0.6;
const BODY_HEIGHT = 0.5;
const BODY_COLOR = 0x4aa3ff;
const NOSE_LENGTH = 0.9;
const NOSE_RADIUS = 0.22;
const NOSE_COLOR = 0xffd166;
// The nose points along +Z in local space; the rig's Y-rotation aims it.
const NOSE_OFFSET_Z = BODY_RADIUS + NOSE_LENGTH / 2;

// --- Aim reticle drawn flat on the ground at the cursor's world point. ---
const RETICLE_INNER = 0.5;
const RETICLE_OUTER = 0.7;
const RETICLE_COLOR = 0xff5d5d;
const RETICLE_LIFT = 0.02; // tiny lift to avoid z-fighting with the ground

const sample: Sample = {
  id: "11-top-down-twin-stick",
  title: "Top-Down Twin-Stick Movement",
  summary:
    "Top-down twin-stick: WASD moves on world axes; the player faces the mouse cursor. Movement and aim are decoupled — strafe while aiming elsewhere.",
  tags: ["controller", "input", "camera"],

  mount(ctx: SampleContext): () => void {
    const { scene, camera, canvas } = ctx;

    const lights = createLightPreset(scene, { background: SCENE_BACKGROUND });
    const ground = createGround(scene);
    const boxGrid = createBoxGrid(scene, {
      count: GRID_COUNT,
      spacing: GRID_SPACING,
    });

    // Player body (a short cylinder = a disc seen from above).
    const bodyGeo = new CylinderGeometry(
      BODY_RADIUS,
      BODY_RADIUS,
      BODY_HEIGHT,
      24,
    );
    const bodyMat = new MeshStandardMaterial({ color: BODY_COLOR });
    const player = new Mesh(bodyGeo, bodyMat);
    player.position.set(START_X, GROUND_Y + BODY_HEIGHT / 2, START_Z);

    // Nose cone parented to the body so it inherits the body's Y-rotation. The
    // cone's tip points +Y by default; rotate it to point along the body's +Z
    // so the rig's yaw aims it horizontally toward the cursor.
    const noseGeo = new ConeGeometry(NOSE_RADIUS, NOSE_LENGTH, 16);
    const noseMat = new MeshStandardMaterial({ color: NOSE_COLOR });
    const nose = new Mesh(noseGeo, noseMat);
    nose.rotation.x = Math.PI / 2; // tip now points +Z (local)
    nose.position.set(0, 0, NOSE_OFFSET_Z);
    player.add(nose);
    scene.add(player);

    // Aim reticle: a flat ring laid on the ground at the world aim point.
    const reticleGeo = new RingGeometry(RETICLE_INNER, RETICLE_OUTER, 32);
    const reticleMat = new MeshStandardMaterial({ color: RETICLE_COLOR });
    const reticle = new Mesh(reticleGeo, reticleMat);
    reticle.rotation.x = -Math.PI / 2; // lay flat on XZ
    reticle.position.y = GROUND_Y + RETICLE_LIFT;
    scene.add(reticle);

    // Keyboard-only input: pass lockOnClick:false so it never grabs pointer
    // lock (we need the absolute cursor visible for top-down aim).
    const input = new InputController({
      pointerLockTarget: canvas,
      lockOnClick: false,
    });

    const hud = new Hud({
      container: canvas.parentElement ?? undefined,
      controls: [
        "WASD — move (world axes)",
        "Mouse — aim / face cursor",
        "Movement and aim are independent",
      ],
    });

    // --- Aim via raycast against the ground plane. ---
    // Absolute cursor in NDC, updated on every canvas mousemove. We do NOT use
    // pointer lock: that hides the cursor and yields only relative deltas, which
    // is wrong for top-down cursor aim.
    const pointerNdc = new Vector2(0, 0);
    let hasPointer = false;
    const onMouseMove = (e: MouseEvent): void => {
      const rect = canvas.getBoundingClientRect();
      pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      hasPointer = true;
    };
    canvas.addEventListener("mousemove", onMouseMove);

    // Reusable raycaster + ground plane (y = GROUND_Y, normal +Y) and scratch
    // vectors to avoid per-frame allocation.
    const raycaster = new Raycaster();
    const groundPlane = new Plane(new Vector3(0, 1, 0), -GROUND_Y);
    const aimPoint = new Vector3();
    const move = new Vector3();
    // Last valid aim direction (so facing holds steady if a ray ever misses).
    let aimYaw = 0;

    let raf = 0;
    let last = performance.now();

    const update = (now: number): void => {
      raf = requestAnimationFrame(update);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      hud.frame(now);

      // --- World-axis WASD movement (decoupled from facing). +Z is "down" on
      // screen for our slightly-tilted top-down camera, so S moves +Z, W -Z. ---
      move.set(0, 0, 0);
      if (input.isDown("KeyW")) move.z -= 1;
      if (input.isDown("KeyS")) move.z += 1;
      if (input.isDown("KeyA")) move.x -= 1;
      if (input.isDown("KeyD")) move.x += 1;
      if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(MOVE_SPEED * dt);
        player.position.x += move.x;
        player.position.z += move.z;
      }

      // --- Aim: raycast the cursor against the ground plane. intersectPlane
      // can return null (ray parallel to the plane, or cursor "above" the
      // horizon on a tilted cam); in that case keep the last facing. ---
      if (hasPointer) {
        raycaster.setFromCamera(pointerNdc, camera);
        const hit = raycaster.ray.intersectPlane(groundPlane, aimPoint);
        if (hit) {
          const dx = aimPoint.x - player.position.x;
          const dz = aimPoint.z - player.position.z;
          // Only update facing when the cursor isn't right on the player, to
          // avoid jittery yaw from a near-zero direction vector.
          if (dx * dx + dz * dz > 1e-4) {
            aimYaw = Math.atan2(dx, dz);
          }
          reticle.position.set(aimPoint.x, GROUND_Y + RETICLE_LIFT, aimPoint.z);
          reticle.visible = true;
        } else {
          reticle.visible = false;
        }
      } else {
        reticle.visible = false;
      }
      // The rig faces the aim point: +Z local is the nose, so yaw = atan2(dx,dz).
      player.rotation.y = aimYaw;

      // --- Top-down follow camera (fixed orientation; tracks XZ only). ---
      camera.position.set(
        player.position.x,
        GROUND_Y + CAMERA_HEIGHT,
        player.position.z + CAMERA_BACK,
      );
      camera.lookAt(player.position.x, CAMERA_LOOK_HEIGHT, player.position.z);
    };
    raf = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("mousemove", onMouseMove);
      input.dispose();
      hud.dispose();
      scene.remove(player);
      scene.remove(reticle);
      bodyGeo.dispose();
      bodyMat.dispose();
      noseGeo.dispose();
      noseMat.dispose();
      reticleGeo.dispose();
      reticleMat.dispose();
      lights.dispose();
      ground.dispose();
      boxGrid.dispose();
    };
  },
};

export default sample;
