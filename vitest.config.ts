import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

/**
 * Context: every test runs in Node, with no browser and no React — the package runs on every
 * platform, so what it does is proven where nothing of a platform is there to help.
 *
 * The alias exists because the source imports itself (`@sincpro/client-framework/...`): without
 * it the name would resolve through `exports` to `dist/`, which a test must never need.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@sincpro\/client-framework$/, replacement: `${src}/index.ts` },
      // The optional entries live in adapters/, as package.json's `exports` says.
      {
        find: /^@sincpro\/client-framework\/(opentelemetry|sentry)$/,
        replacement: `${src}/adapters/$1.ts`,
      },
      { find: /^@sincpro\/client-framework\//, replacement: `${src}/` },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
