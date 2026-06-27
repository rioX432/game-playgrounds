// Server-internal measurement uplink. This is TOOLING, not part of the
// cross-engine game protocol, so it deliberately stays OUT of net/protocol (which
// must remain thin). A probe client closes the RTT loop on its side and reports
// the result back here for aggregation into the MetricsSample.

/** client -> server telemetry message type id. */
export const MSG_STAT = 'stat';

/** A probe client's per-snapshot measurement, reported back to the server. */
export interface StatMessage {
  /** Round-trip time derived from an echoed input seq, ms. */
  rttMs: number;
  /** Age of the just-received snapshot at receipt, ms. */
  snapshotAgeMs: number;
}
