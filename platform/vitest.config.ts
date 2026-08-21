import { defineConfig } from "vitest/config";

// The engine core (parser, DAG, expressions, driver, actions) is deliberately
// free of Workers-runtime imports so it runs under plain Node here. Only the
// binding-level wiring (runner, store, DOs, API) needs workerd, and that is
// exercised with `wrangler dev` / vitest-pool-workers separately.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
