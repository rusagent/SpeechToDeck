import tseslint from "typescript-eslint";

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
        files: ["src/infrastructure/steam/**/*.ts", "src/infrastructure/steam/**/*.tsx"],
        rules: {
            "@typescript-eslint/no-explicit-any": "off",
        },
    },
);
