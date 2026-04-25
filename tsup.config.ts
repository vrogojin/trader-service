import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    // Trader standalone entrypoint. It already implements the ACP-0
    // handshake (acp.hello / heartbeat / acp.command) via the in-tree
    // AcpListener, so it doubles as the ACP-wrapped entrypoint.
    'trader/main': 'src/trader/main.ts',
    // Thin shim re-exporting startTrader; the Dockerfile's default CMD
    // targets dist/acp-adapter/main.js to mirror the escrow-service layout.
    'acp-adapter/main': 'src/acp-adapter/main.ts',
    // Controller-side CLI (bin/trader-ctl shim execs dist/cli/main.js).
    'cli/main': 'src/cli/main.ts',
  },
  format: ['esm'],
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  outDir: 'dist',
  external: [
    '@unicitylabs/sphere-sdk',
    '@unicitylabs/sphere-sdk/impl/nodejs',
  ],
});
