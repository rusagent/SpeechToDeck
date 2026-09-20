import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Frontend unit tests run in a DOM-like environment.
        environment: "jsdom",
        include: ["tests/**/*.test.?(m)ts?(x)"],
        // The gate must fail while no tests exist; `passWithNoTests` stays off.
    },
});
