import { Playground } from "./engine/bootstrap";
import { samples, findSample } from "./samples/registry";
import type { Sample } from "./samples/types";

const canvas = document.getElementById("app") as HTMLCanvasElement | null;
const sidebar = document.getElementById("sidebar");
const overlay = document.getElementById("overlay");

if (!canvas || !sidebar || !overlay) {
  throw new Error("Required DOM elements (#app, #sidebar, #overlay) missing.");
}

const playground = new Playground(canvas);

/** Build the left sidebar list from the registry. */
function buildSidebar(): void {
  const heading = document.createElement("h1");
  heading.textContent = "Babylon Playground";
  sidebar!.appendChild(heading);

  const list = document.createElement("ul");
  list.className = "sample-list";
  for (const sample of samples) {
    const li = document.createElement("li");
    li.dataset.id = sample.id;

    const title = document.createElement("span");
    title.className = "sample-title";
    title.textContent = sample.title;
    li.appendChild(title);

    const tags = document.createElement("span");
    tags.className = "sample-tags";
    tags.textContent = sample.tags.join(" · ");
    li.appendChild(tags);

    li.addEventListener("click", () => {
      location.hash = `#/${sample.id}`;
    });
    list.appendChild(li);
  }
  sidebar!.appendChild(list);
}

/** Update the overlay (title + summary) and the active sidebar row. */
function renderOverlay(sample: Sample): void {
  // The previous sample's own overlay UI was already removed by its dispose fn
  // (run during teardown, before this hook fires), so it is safe to reset here.
  overlay!.innerHTML = "";
  const title = document.createElement("h2");
  title.textContent = sample.title;
  const summary = document.createElement("p");
  summary.textContent = sample.summary;
  overlay!.appendChild(title);
  overlay!.appendChild(summary);

  sidebar!
    .querySelectorAll("li")
    .forEach((li) =>
      li.classList.toggle("active", li.dataset.id === sample.id),
    );
}

/** Resolve the current hash to a sample and mount it. */
function route(): void {
  const id = location.hash.replace(/^#\/?/, "");
  const sample = findSample(id) ?? samples[0];
  if (!sample) return;
  // beforeMount runs after the old sample is torn down but before the new one
  // mounts, so each sample's overlay UI lifecycle stays clean.
  playground.load(sample, () => renderOverlay(sample));
}

buildSidebar();
window.addEventListener("hashchange", route);

// Deep-link on load, or default to the first sample.
if (!location.hash) {
  location.hash = `#/${samples[0]?.id ?? ""}`;
} else {
  route();
}
