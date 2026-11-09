import { defineConfig } from "vitest/config";

// Testes que exigem o emulador do Firestore (rodam via `pnpm test:integration`).
export default defineConfig({
  test: {
    include: ["test/**/*.integration.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    silent: true,
  },
});
