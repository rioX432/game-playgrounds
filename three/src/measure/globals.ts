// Browser-exposed harvest hook for auto-measure mode (#171). Replaces the old
// Space-bar-spam HUD approach: each emitted RenderSample is pushed to a global array
// AND console.logged as one JSONL line, so a headless smoke OR a manual operator can
// pull the sidecar out of the page.
//
// HONEST CAVEAT (mirrors net/web-three's smoke note): under headless Chromium, WebGL
// is rendered via SwiftShader (software), so auto-measure numbers collected headless
// are PIPELINE-faithful (raw dt -> shared sampler -> sidecar) but NOT real-GPU. A
// real-GPU baseline is a separate manual run in a headed browser.

import type { RenderSample } from "./renderSample";

/** Console prefix on each emitted JSONL line, for log-based harvesting. */
export const RENDER_SAMPLE_LOG_PREFIX = "[render-sample]";

declare global {
  interface Window {
    /** Append-only array of emitted auto-measure samples (a smoke polls it). */
    __renderSamples?: RenderSample[];
  }
}

/**
 * Install the harvest hook onto `window` and return a sink that records each emitted
 * sample into `window.__renderSamples` (created if absent) AND logs it as one JSONL
 * line. Kept out of the probe core to preserve the probe's no-DOM, headless-testable
 * purity.
 */
export function installRenderSampleSink(): (sample: RenderSample) => void {
  const samples: RenderSample[] = (window.__renderSamples ??= []);
  return (sample) => {
    samples.push(sample);
    console.log(`${RENDER_SAMPLE_LOG_PREFIX} ${JSON.stringify(sample)}`);
  };
}
