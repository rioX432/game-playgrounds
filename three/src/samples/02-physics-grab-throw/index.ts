import RAPIER from "@dimforge/rapier3d-compat";
import {
  BoxGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Raycaster,
  Vector2,
  Vector3,
} from "three";
import type { Sample, SampleContext } from "../types";

// Tuning constants.
const GRAVITY_Y = -9.81;
const BOX_COUNT = 8;
const BOX_HALF = 0.4;
const HOLD_DISTANCE = 4; // how far in front of the camera a grabbed body is held
const HOLD_STIFFNESS = 14; // velocity gain pulling a held body to the target
const THROW_IMPULSE = 12;
const FLOOR_HALF = 20;

interface Body {
  mesh: Mesh;
  rb: RAPIER.RigidBody;
}

const sample: Sample = {
  id: "02-physics-grab-throw",
  title: "Physics Grab & Throw",
  summary:
    "Rapier physics. Click to grab the body under the crosshair, hold at a distance, click again to throw (impulse).",
  tags: ["physics", "rapier", "raycast", "interaction"],

  mount(ctx: SampleContext): () => void {
    const { scene, camera, canvas } = ctx;
    scene.background = new Color(0x0c0f14);
    camera.position.set(0, 5, 12);
    camera.lookAt(0, 1, 0);

    const hemi = new HemisphereLight(0xbfd4ff, 0x202020, 0.9);
    scene.add(hemi);
    const dir = new DirectionalLight(0xffffff, 1.3);
    dir.position.set(6, 12, 6);
    scene.add(dir);

    const floorMesh = new Mesh(
      new PlaneGeometry(FLOOR_HALF * 2, FLOOR_HALF * 2),
      new MeshStandardMaterial({ color: 0x26303a }),
    );
    floorMesh.rotation.x = -Math.PI / 2;
    scene.add(floorMesh);

    let disposed = false;
    let raf = 0;
    const bodies: Body[] = [];
    const raycaster = new Raycaster();
    const center = new Vector2(0, 0); // crosshair = screen center in NDC

    let world: RAPIER.World | null = null;
    let grabbed: Body | null = null;

    // Rapier's -compat build must be initialised before use; init() resolves a
    // WASM module. We build the world only after it is ready, and guard against
    // the sample being unmounted during the await.
    void RAPIER.init().then(() => {
      if (disposed) return;
      world = new RAPIER.World(new RAPIER.Vector3(0, GRAVITY_Y, 0));

      // Static floor collider.
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(FLOOR_HALF, 0.1, FLOOR_HALF),
        world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.1, 0)),
      );

      // Dynamic boxes.
      const boxGeo = new BoxGeometry(BOX_HALF * 2, BOX_HALF * 2, BOX_HALF * 2);
      for (let i = 0; i < BOX_COUNT; i++) {
        const x = (i % 4) * 1.2 - 1.8;
        const z = Math.floor(i / 4) * 1.2 - 0.6;
        const y = 0.5 + (i % 3) * 0.9;
        const mesh = new Mesh(
          boxGeo,
          new MeshStandardMaterial({ color: new Color().setHSL(i / BOX_COUNT, 0.6, 0.55) }),
        );
        scene.add(mesh);

        const rb = world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z),
        );
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(BOX_HALF, BOX_HALF, BOX_HALF).setRestitution(0.2),
          rb,
        );
        bodies.push({ mesh, rb });
      }

      raf = requestAnimationFrame(step);
    });

    const grabTarget = new Vector3();
    const camDir = new Vector3();

    const step = () => {
      raf = requestAnimationFrame(step);
      if (!world) return;

      // Keep a grabbed body floating at HOLD_DISTANCE in front of the camera by
      // driving its linear velocity toward the target (kinematic-by-velocity).
      if (grabbed) {
        camera.getWorldDirection(camDir);
        grabTarget.copy(camera.position).add(camDir.multiplyScalar(HOLD_DISTANCE));
        const pos = grabbed.rb.translation();
        const vx = (grabTarget.x - pos.x) * HOLD_STIFFNESS;
        const vy = (grabTarget.y - pos.y) * HOLD_STIFFNESS;
        const vz = (grabTarget.z - pos.z) * HOLD_STIFFNESS;
        grabbed.rb.setLinvel(new RAPIER.Vector3(vx, vy, vz), true);
        grabbed.rb.setAngvel(new RAPIER.Vector3(0, 0, 0), true);
      }

      world.step();

      // Sync meshes from physics bodies.
      for (const b of bodies) {
        const t = b.rb.translation();
        const r = b.rb.rotation();
        b.mesh.position.set(t.x, t.y, t.z);
        b.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      }
    };

    const onClick = () => {
      if (!world) return;
      if (grabbed) {
        // Throw along the camera direction.
        camera.getWorldDirection(camDir);
        grabbed.rb.applyImpulse(
          new RAPIER.Vector3(
            camDir.x * THROW_IMPULSE,
            camDir.y * THROW_IMPULSE,
            camDir.z * THROW_IMPULSE,
          ),
          true,
        );
        grabbed = null;
        return;
      }
      // Raycast from crosshair (screen center) to grab nearest box mesh.
      raycaster.setFromCamera(center, camera);
      const hits = raycaster.intersectObjects(
        bodies.map((b) => b.mesh),
        false,
      );
      if (hits.length > 0) {
        const hit = hits[0].object;
        grabbed = bodies.find((b) => b.mesh === hit) ?? null;
      }
    };
    canvas.addEventListener("click", onClick);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("click", onClick);
      world?.free();
      world = null;
    };
  },
};

export default sample;
