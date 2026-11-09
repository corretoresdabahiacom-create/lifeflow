import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.rules.test.ts"],
    testTimeout: 20000,
    hookTimeout: 30000,
    // Um único projeto de emulador compartilhado: executar em série.
    fileParallelism: false,
  },
});
