// `net/protocol` — shared, transport-agnostic types for the networking chapter.
//
// Keep this barrel THIN. Only cross-engine, cross-transport contracts belong
// here. The first contract is the measurement schema (Issue #140).
export { ENGINES } from './metrics.js';
export type { Engine, MetricsSample } from './metrics.js';
