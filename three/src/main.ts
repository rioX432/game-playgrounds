import { Engine } from "./engine/bootstrap";
import { parseMeasureParams } from "./measure/config";
import { samples } from "./samples/registry";
import type { Sample } from "./samples/types";

const canvas = document.getElementById("app") as HTMLCanvasElement | null;
const sidebar = document.getElementById("sidebar");
const overlay = document.getElementById("overlay");

if (!canvas || !sidebar || !overlay) {
  throw new Error("Required DOM elements (#app, #sidebar, #overlay) missing");
}

// WebGPU measure path (#172): when `?renderer=webgl|webgpu` is present, the run drives
// a WebGPURenderer instead of the classic gallery. The three/webgpu graph is loaded by
// a DYNAMIC import so the classic gallery bundle never co-loads it at runtime (PR0
// runtime-graph rule). When `?renderer` is absent, the classic path below is untouched.
const measureParams = parseMeasureParams(location.search);
if (measureParams.rendererMode !== "classic") {
  import("./engine/webgpu/measureWebgpu")
    .then(({ runWebgpuMeasure }) => runWebgpuMeasure(canvas, measureParams))
    .catch((err: unknown) => {
      // Surface chunk-load / RAPIER.init / renderer.init failures instead of a silent
      // blank canvas (e.g. a host where both WebGPU and the WebGL2 fallback are absent).
      console.error("[measure] WebGPU measure path failed:", err);
      overlay.textContent = `WebGPU measure path failed: ${String(err)}`;
    });
} else {
  startGallery(canvas, sidebar, overlay);
}

function startGallery(
  canvas: HTMLCanvasElement,
  sidebar: HTMLElement,
  overlay: HTMLElement,
): void {
  const engine = new Engine(canvas);

  // Build the sidebar list.
  const buttons = new Map<string, HTMLButtonElement>();
  for (const sample of samples) {
    const btn = document.createElement("button");
    btn.className = "sample-link";
    btn.innerHTML = `
    <span class="sample-link-title">${sample.title}</span>
    <span class="sample-link-tags">${sample.tags.map((t) => `#${t}`).join(" ")}</span>
  `;
    btn.addEventListener("click", () => {
      location.hash = `#/${sample.id}`;
    });
    buttons.set(sample.id, btn);
    sidebar.appendChild(btn);
  }

  function activate(sample: Sample): void {
    // Clear per-sample overlay UI before mounting the next.
    overlay.innerHTML = `
    <div class="overlay-card">
      <h2>${sample.title}</h2>
      <p>${sample.summary}</p>
    </div>
  `;
    for (const [id, btn] of buttons) {
      btn.classList.toggle("active", id === sample.id);
    }
    engine.mount(sample);
  }

  function syncFromHash(): void {
    const id = location.hash.replace(/^#\//, "");
    const sample = samples.find((s) => s.id === id) ?? samples[0];
    if (sample) activate(sample);
  }

  window.addEventListener("hashchange", syncFromHash);

  // Deep-link on load. Honor `?sample=<id>` (the auto-measure URL contract carries the
  // sample in the query, before the hash) so measure runs route to the right sample;
  // otherwise fall back to the hash, then the first sample.
  const requestedSample = new URLSearchParams(location.search).get("sample");
  if (!location.hash && requestedSample) {
    location.hash = `#/${requestedSample}`;
  } else if (!location.hash && samples[0]) {
    location.hash = `#/${samples[0].id}`;
  } else {
    syncFromHash();
  }
}
