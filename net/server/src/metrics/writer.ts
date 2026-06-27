// Append-only JSON Lines writer: one MetricsSample per line (net/CLAUDE.md
// convention — no arrays, no nesting). IO is isolated here so the collector
// stays pure.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MetricsSample } from 'net-protocol';

/** Writes MetricsSample lines to a metrics.jsonl file. */
export class MetricsWriter {
  private ensured = false;

  constructor(private readonly path: string) {}

  /** Append one sample as a single JSON line. */
  write(sample: MetricsSample): void {
    if (!this.ensured) {
      mkdirSync(dirname(this.path), { recursive: true });
      this.ensured = true;
    }
    appendFileSync(this.path, `${JSON.stringify(sample)}\n`);
  }
}
