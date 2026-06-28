// Nearest-rank percentile — mirrors the private percentileNearestRank in
// net/protocol/src/clientRender.ts. COPIED, not shared, so this subdir stays
// self-contained (CLAUDE.md Core Value #2). The nearest-rank rule
// (rank = ceil(p/100 * n)) is kept INTENTIONALLY identical to net/protocol so the
// frame-time percentiles here are methodologically comparable to that chapter's.

/**
 * Nearest-rank percentile over an ascending-sorted array. For `n` values the p-th
 * percentile is the value at 1-based rank `ceil(p/100 * n)`, with the resulting
 * index clamped into `[0, n-1]`. Returns 0 for an empty array.
 * Precondition: `sortedAsc` is sorted ascending.
 */
export function percentileNearestRank(
  sortedAsc: readonly number[],
  p: number,
): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const rank = Math.ceil((p / 100) * n);
  const index = Math.min(Math.max(rank, 1), n) - 1;
  return sortedAsc[index];
}
