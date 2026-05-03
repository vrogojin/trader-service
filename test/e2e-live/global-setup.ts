/**
 * Vitest globalSetup for the e2e-live suite.
 *
 * Runs ONCE before any test file. If the preflight throws, vitest aborts
 * the entire run before booting the host-manager binary or spawning any
 * tenant containers — saving the multi-minute round-trip we'd otherwise
 * eat on a relay outage or unreachable aggregator.
 */

import { runPreflight } from './preflight.js';

export async function setup(): Promise<void> {
  await runPreflight();
}
