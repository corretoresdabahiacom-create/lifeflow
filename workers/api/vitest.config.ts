import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Os testes de integração precisam do emulador: rodam em `pnpm test:integration`.
    exclude: [...configDefaults.exclude, "test/**/*.integration.test.ts"],
    // Os logs estruturados do Worker poluem a saída; os testes que precisam deles usam spy.
    silent: true,
  },
});
