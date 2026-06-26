import {
  CanvasTexture,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  Raycaster,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
} from "three";
import type { Sample, SampleContext } from "../types";

// Texture canvas resolution and brush size in texel space.
const TEX_SIZE = 1024;
const BRUSH_RADIUS = 28;
const BASE_COLOR = "#cccccc";
// Idle spin speed in rad/SECOND (delta-scaled, refresh-rate independent).
// 0.003 rad/frame x 60 fps = 0.18 rad/s preserves the original 60 Hz feel.
// (The Bevy peer uses 0.3 rad/s; kept at 0.18 to match the original here.)
const AUTOROTATE_SPEED = 0.18;
const PALETTE = ["#ff3b30", "#34c759", "#0a84ff", "#ffd60a", "#ff2d92", "#000000"];

const sample: Sample = {
  id: "03-paint-on-mesh",
  title: "Paint on Mesh",
  summary:
    "Drag to paint directly onto a sphere's CanvasTexture using the hit UV. The 'paint-to-disguise' core. Pick a color from the palette.",
  tags: ["texture", "raycast", "uv", "paint"],

  mount(ctx: SampleContext): () => void {
    const { scene, camera, canvas } = ctx;
    scene.background = new Color(0x0d1117);
    camera.position.set(0, 0, 4);
    camera.lookAt(0, 0, 0);

    const hemi = new HemisphereLight(0xffffff, 0x303030, 1.0);
    scene.add(hemi);
    const dir = new DirectionalLight(0xffffff, 1.2);
    dir.position.set(3, 4, 5);
    scene.add(dir);

    // Backing 2D canvas that drives the texture.
    const paintCanvas = document.createElement("canvas");
    paintCanvas.width = TEX_SIZE;
    paintCanvas.height = TEX_SIZE;
    const c2d = paintCanvas.getContext("2d");
    if (!c2d) throw new Error("2D canvas context unavailable");
    c2d.fillStyle = BASE_COLOR;
    c2d.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

    const texture = new CanvasTexture(paintCanvas);
    texture.colorSpace = SRGBColorSpace;

    const mesh = new Mesh(
      new SphereGeometry(1.2, 64, 48),
      new MeshStandardMaterial({ map: texture, roughness: 0.8, metalness: 0.0 }),
    );
    scene.add(mesh);

    let brushColor = PALETTE[0];
    let painting = false;
    let raf = 0;

    // Slow idle rotation so the unpainted side is reachable.
    let autoRotate = true;
    let last = performance.now();
    const spin = (now: number) => {
      raf = requestAnimationFrame(spin);
      // Delta seconds, clamped to avoid huge jumps after tab-switch.
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (autoRotate && !painting) mesh.rotation.y += AUTOROTATE_SPEED * dt;
    };
    raf = requestAnimationFrame(spin);

    const raycaster = new Raycaster();
    const ndc = new Vector2();

    const paintAt = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObject(mesh, false);
      if (hits.length === 0 || !hits[0].uv) return;
      // UV origin is bottom-left; canvas Y grows downward, so flip V.
      const u = hits[0].uv.x;
      const v = hits[0].uv.y;
      const px = u * TEX_SIZE;
      const py = (1 - v) * TEX_SIZE;
      c2d.fillStyle = brushColor;
      c2d.beginPath();
      c2d.arc(px, py, BRUSH_RADIUS, 0, Math.PI * 2);
      c2d.fill();
      texture.needsUpdate = true;
    };

    const onPointerDown = (e: PointerEvent) => {
      painting = true;
      paintAt(e.clientX, e.clientY);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (painting) paintAt(e.clientX, e.clientY);
    };
    const onPointerUp = () => {
      painting = false;
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    // Color palette UI (DOM, removed on dispose).
    const palette = document.createElement("div");
    palette.className = "sample-palette";
    const swatches: HTMLButtonElement[] = [];
    PALETTE.forEach((hex, i) => {
      const btn = document.createElement("button");
      btn.style.background = hex;
      btn.setAttribute("aria-label", `color ${hex}`);
      if (i === 0) btn.classList.add("active");
      btn.addEventListener("click", () => {
        brushColor = hex;
        swatches.forEach((s) => s.classList.remove("active"));
        btn.classList.add("active");
      });
      swatches.push(btn);
      palette.appendChild(btn);
    });

    const rotateToggle = document.createElement("button");
    rotateToggle.textContent = "auto-rotate: on";
    rotateToggle.className = "sample-toggle";
    rotateToggle.addEventListener("click", () => {
      autoRotate = !autoRotate;
      rotateToggle.textContent = `auto-rotate: ${autoRotate ? "on" : "off"}`;
    });
    palette.appendChild(rotateToggle);

    document.getElementById("overlay")?.appendChild(palette);

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      palette.remove();
      texture.dispose();
    };
  },
};

export default sample;
