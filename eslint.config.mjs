import tseslint from "typescript-eslint";

// Flat config (ESLint 9+). Steam private-API code must live exclusively under
// src/infrastructure/steam/; boundary rules can be tightened there
// once that package exists.
export default tseslint.config(
    {
        ignores: ["dist/", "node_modules/", "coverage/", ".tmp/"],
    },
    ...tseslint.configs.recommended,
    {
        rules: {
            "@typescript-eslint/no-explicit-any": "error",
        },
    },
    {
        // `any` is tolerated only at the Steam private-API boundary and
        // must be converted immediately into typed internal representations.
        files: ["src/infrastructure/steam/**/*.ts", "src/infrastructure/steam/**/*.tsx"],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
        },
    },
);
