// Browser-exposed harvest hooks for the client-render probe (#166).
//
// These let a Playwright smoke OR a manual operator pull the emitted
// `ClientRenderSample` lines out of the page:
//   - `window.__clientRenderSamples` — the array a smoke polls, then writes to
//     `client-render.jsonl` from the Node side;
//   - `window.__clientRenderJsonl()` — the JSONL text (one sample per line);
//   - `window.__downloadClientRenderJsonl()` — trigger a manual file download.
// Each kept sample is ALSO `console.log`ged as a single JSONL line (prefixed)
// so a smoke can harvest from the console instead of the global if it prefers.

import type { ClientRenderSample } from "net-protocol";

/** Console prefix on each emitted JSONL line, for log-based harvesting. */
export const PROBE_LOG_PREFIX = "[client-render]";

/** Suggested filename for the manual download. */
const DOWNLOAD_FILENAME = "client-render.jsonl";
const JSONL_MIME = "application/x-ndjson";

declare global {
  interface Window {
    /** Append-only array of emitted samples (a smoke polls its length). */
    __clientRenderSamples?: ClientRenderSample[];
    /** The samples serialized as JSON Lines (one per line). */
    __clientRenderJsonl?: () => string;
    /** Trigger a browser download of the JSONL (manual procedure). */
    __downloadClientRenderJsonl?: () => void;
  }
}

/**
 * Install the harvest hooks onto `window` and return a sink that records each
 * emitted sample into the global array AND logs it as a JSONL line. Keeping this
 * out of the probe core preserves the probe's no-DOM, headless-testable purity.
 */
export function installProbeGlobals(
  win: Window,
): (sample: ClientRenderSample) => void {
  const samples: ClientRenderSample[] = [];
  win.__clientRenderSamples = samples;
  win.__clientRenderJsonl = () =>
    samples.map((s) => JSON.stringify(s)).join("\n");
  win.__downloadClientRenderJsonl = () => {
    const blob = new Blob([`${win.__clientRenderJsonl?.() ?? ""}\n`], {
      type: JSONL_MIME,
    });
    const url = URL.createObjectURL(blob);
    const a = win.document.createElement("a");
    a.href = url;
    a.download = DOWNLOAD_FILENAME;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (sample) => {
    samples.push(sample);
    // One self-contained JSONL line per kept window — directly harvestable.
    console.log(`${PROBE_LOG_PREFIX} ${JSON.stringify(sample)}`);
  };
}
