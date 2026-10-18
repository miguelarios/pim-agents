import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Clears the developer's own PIM configuration from the environment.
    setupFiles: ["../../vitest.setup.ts"],
  },
});
