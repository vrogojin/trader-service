/**
 * Vitest globalSetup for the e2e-live suite.
 *
 * Runs ONCE before any test file. If the preflight throws, vitest aborts
 * the entire run before spawning any Docker containers — saving the
 * 10-15-minute round trip we'd otherwise eat on a relay outage or
 * unreachable aggregator.
 */

import { runPreflight } from './preflight.js';

export async function setup(): Promise<void> {
  await runPreflight();
}
