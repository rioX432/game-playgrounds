import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Ray } from "@babylonjs/core/Culling/ray";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import "@babylonjs/core/Meshes/Builders/groundBuilder";
import "@babylonjs/core/Meshes/Builders/boxBuilder";
import "@babylonjs/core/Culling/ray";
import "@babylonjs/core/Physics/physicsEngineComponent";

import { getHavokPlugin } from "../../engine/havok";
import type { Sample, SampleContext } from "../types";

const HOLD_DISTANCE = 6; // units in front of the camera the held body floats
const GRAB_RANGE = 30; // max raycast distance to pick a body
const THROW_IMPULSE = 18; // impulse magnitude applied on throw
const SPRING = 60; // how hard the held body is pulled toward the hold point

function sample02Mount(ctx: SampleContext): () => void {
  const { scene, canvas } = ctx;
  scene.clearColor.set(0.08, 0.09, 0.12, 1);

  let disposed = false;
  const cleanups: Array<() => void> = [];

  // --- Camera (orbit; left-drag look, wheel zoom) ---
  const camera = new ArcRotateCamera(
    "cam",
    -Math.PI / 2,
    Math.PI / 2.6,
    16,
    new Vector3(0, 1.5, 0),
    scene,
  );
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = 6;
  camera.upperRadiusLimit = 40;

  const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.6;
  const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, -0.3), scene);
  sun.intensity = 0.7;

  // Async because Havok WASM loads on demand. We guard with `disposed` in case
  // the user switches samples before the runtime finishes loading.
  void getHavokPlugin().then((plugin) => {
    if (disposed) return;
    scene.enablePhysics(new Vector3(0, -9.81, 0), plugin);

    // --- Floor ---
    const floor = MeshBuilder.CreateGround(
      "floor",
      { width: 40, height: 40 },
      scene,
    );
    const floorMat = new StandardMaterial("floorMat", scene);
    floorMat.diffuseColor = new Color3(0.2, 0.22, 0.28);
    floor.material = floorMat;
    new PhysicsAggregate(floor, PhysicsShapeType.BOX, { mass: 0 }, scene);

    // --- Dynamic boxes ---
    const bodyMat = new StandardMaterial("bodyMat", scene);
    bodyMat.diffuseColor = new Color3(0.85, 0.4, 0.35);
    const dynamicBoxes: Mesh[] = [];
    for (let i = 0; i < 8; i++) {
      const box = MeshBuilder.CreateBox("dyn" + i, { size: 1.2 }, scene);
      box.position.set((i % 4) * 2 - 3, 1 + Math.floor(i / 4) * 1.5, 0);
      box.material = bodyMat;
      new PhysicsAggregate(
        box,
        PhysicsShapeType.BOX,
        { mass: 1, restitution: 0.2, friction: 0.6 },
        scene,
      );
      dynamicBoxes.push(box);
    }

    // --- Grab / hold / throw ---
    // Click-to-grab, click-to-throw (a single toggle), matching the Three.js and
    // Bevy peers — one interaction grammar across all three engines.
    let held: Mesh | null = null;

    const onPointerDown = (e: PointerEvent): void => {
      // Holding a body: this click throws it along the camera forward + releases.
      if (held) {
        const dir = camera
          .getForwardRay(1)
          .direction.normalize()
          .scale(THROW_IMPULSE);
        held.physicsBody?.applyImpulse(dir, held.getAbsolutePosition());
        held = null;
        return;
      }
      // Nothing held: cast a ray from the camera through the pointer and grab the
      // nearest dynamic body in range.
      const ray = scene.createPickingRay(
        scene.pointerX,
        scene.pointerY,
        null,
        camera,
      );
      const hit = scene.pickWithRay(ray, (m) =>
        dynamicBoxes.includes(m as Mesh),
      );
      if (hit?.pickedMesh && hit.distance <= GRAB_RANGE) {
        held = hit.pickedMesh as Mesh;
        // Stop residual spin so the held body sits calmly at the hold point.
        held.physicsBody?.setAngularVelocity(Vector3.Zero());
      }
      void e;
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    cleanups.push(() => {
      canvas.removeEventListener("pointerdown", onPointerDown);
    });

    // Spring the held body toward a point in front of the camera each frame.
    const holdUpdate = (): void => {
      if (!held?.physicsBody) return;
      const ray: Ray = camera.getForwardRay(HOLD_DISTANCE);
      const target = ray.origin.add(ray.direction.scale(HOLD_DISTANCE));
      const toTarget = target.subtract(held.getAbsolutePosition());
      // Critically-ish damped: velocity proportional to error, damped by reading current.
      held.physicsBody.setLinearVelocity(toTarget.scale(SPRING * 0.05));
    };
    scene.onBeforeRenderObservable.add(holdUpdate);
    cleanups.push(() => scene.onBeforeRenderObservable.removeCallback(holdUpdate));
  });

  return () => {
    disposed = true;
    for (const c of cleanups) c();
  };
}

export const sample02: Sample = {
  id: "02-physics-grab-throw",
  title: "Physics Grab & Throw (Havok)",
  summary:
    "Havok world: click to grab the nearest dynamic box, hold it at a distance, click again to throw.",
  tags: ["physics", "havok", "raycast", "impulse"],
  mount: sample02Mount,
};

export default sample02;
