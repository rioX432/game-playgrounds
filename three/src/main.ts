import { Engine } from "./engine/bootstrap";
import { samples } from "./samples/registry";
import type { Sample } from "./samples/types";

const canvas = document.getElementById("app") as HTMLCanvasElement | null;
const sidebar = document.getElementById("sidebar");
const overlay = document.getElementById("overlay");

if (!canvas || !sidebar || !overlay) {
  throw new Error("Required DOM elements (#app, #sidebar, #overlay) missing");
}

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
  overlay!.innerHTML = `
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
