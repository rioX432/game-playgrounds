import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents";
import type { PointerInfo } from "@babylonjs/core/Events/pointerEvents";
import "@babylonjs/core/Meshes/Builders/sphereBuilder";

import type { Sample, SampleContext } from "../types";

const TEX_SIZE = 1024;
const BRUSH_RADIUS = 22; // pixels on the texture
const PALETTE: Array<{ name: string; css: string }> = [
  { name: "red", css: "#e63946" },
  { name: "green", css: "#2a9d8f" },
  { name: "blue", css: "#457b9d" },
  { name: "yellow", css: "#e9c46a" },
  { name: "magenta", css: "#b5179e" },
  { name: "white", css: "#f1faee" },
];

function sample03Mount(ctx: SampleContext): () => void {
  const { scene, canvas } = ctx;
  scene.clearColor.set(0.1, 0.11, 0.13, 1);

  const camera = new ArcRotateCamera(
    "cam",
    -Math.PI / 2,
    Math.PI / 2.4,
    7,
    new Vector3(0, 0, 0),
    scene,
  );
  camera.attachControl(canvas, true);
  camera.lowerRadiusLimit = 3;
  camera.upperRadiusLimit = 14;

  const hemi = new HemisphericLight("hemi", new Vector3(0.3, 1, 0.2), scene);
  hemi.intensity = 0.9;

  // --- Paintable sphere with a DynamicTexture as its diffuse map ---
  const sphere = MeshBuilder.CreateSphere(
    "paintTarget",
    { diameter: 4, segments: 48 },
    scene,
  );

  const dynTex = new DynamicTexture(
    "paintTex",
    { width: TEX_SIZE, height: TEX_SIZE },
    scene,
    false,
  );
  // Prime the canvas with a neutral base color.
  const tctx = dynTex.getContext() as CanvasRenderingContext2D;
  tctx.fillStyle = "#cfd2d6";
  tctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  dynTex.update();

  const mat = new StandardMaterial("paintMat", scene);
  mat.diffuseTexture = dynTex;
  mat.specularColor = new Color3(0.1, 0.1, 0.1);
  sphere.material = mat;

  // --- Brush color state + minimal palette UI ---
  let brushColor = PALETTE[0].css;

  const palette = document.createElement("div");
  palette.className = "sample-palette";
  PALETTE.forEach((entry, idx) => {
    const swatch = document.createElement("button");
    swatch.className = "swatch";
    swatch.style.background = entry.css;
    swatch.title = entry.name;
    if (idx === 0) swatch.classList.add("active");
    swatch.addEventListener("click", () => {
      brushColor = entry.css;
      palette
        .querySelectorAll(".swatch")
        .forEach((s) => s.classList.remove("active"));
      swatch.classList.add("active");
    });
    palette.appendChild(swatch);
  });
  const overlay = document.getElementById("overlay");
  overlay?.appendChild(palette);

  // --- Paint on pick ---
  let painting = false;

  const paintAt = (pickU: number, pickV: number): void => {
    // getTextureCoordinates returns UV in [0,1]; V is flipped vs. canvas Y.
    const x = pickU * TEX_SIZE;
    const y = (1 - pickV) * TEX_SIZE;
    tctx.fillStyle = brushColor;
    tctx.beginPath();
    tctx.arc(x, y, BRUSH_RADIUS, 0, Math.PI * 2);
    tctx.fill();
    dynTex.update();
  };

  const tryPaint = (): void => {
    const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m === sphere);
    if (!pick?.hit) return;
    const uv = pick.getTextureCoordinates();
    if (uv) paintAt(uv.x, uv.y);
  };

  const onPointer = (info: PointerInfo): void => {
    switch (info.type) {
      case PointerEventTypes.POINTERDOWN:
        painting = true;
        tryPaint();
        break;
      case PointerEventTypes.POINTERUP:
        painting = false;
        break;
      case PointerEventTypes.POINTERMOVE:
        if (painting) tryPaint();
        break;
    }
  };
  scene.onPointerObservable.add(onPointer);

  return () => {
    scene.onPointerObservable.removeCallback(onPointer);
    palette.remove();
  };
}

export const sample03: Sample = {
  id: "03-paint-on-mesh",
  title: "Paint on Mesh (DynamicTexture)",
  summary:
    "Paint-to-disguise core: pick the sphere, read UV via getTextureCoordinates(), and stamp brush dots onto a DynamicTexture.",
  tags: ["texture", "paint", "uv", "dynamic-texture"],
  mount: sample03Mount,
};

export default sample03;
