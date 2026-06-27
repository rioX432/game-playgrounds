import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Room boots use real timers (setSimulationInterval); keep them.
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 20000,
    // Use the worker_threads pool, NOT the default child_process `forks` pool:
    // Colyseus's process-level messaging collides with tinypool's IPC channel
    // and corrupts vitest's worker RPC. worker_threads use a private
    // MessageChannel, so there is no collision.
    pool: 'threads',
    // The integration test boots a Colyseus server; run files sequentially to
    // avoid port/listener contention.
    fileParallelism: false,
  },
});
