import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Os logs estruturados do Worker poluem a saída; os testes que precisam deles usam spy.
    silent: true,
  },
});
