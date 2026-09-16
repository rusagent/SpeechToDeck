import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import esbuild from "rollup-plugin-esbuild";

// Decky loads the plugin frontend from dist/index.js (spec §112 Packaging).
// The Steam client and Decky Loader provide react, react-dom, @decky/ui and
// @decky/api at runtime, so they are externals and are mapped to globals in
// the IIFE output.
const externals = (id) =>
    ["react", "react-dom", "@decky/ui", "@decky/api"].some(
        (dep) => id === dep || id.startsWith(`${dep}/`),
    );

const globals = {
    react: "React",
    "react-dom": "ReactDOM",
    // createRoot lives on the same react-dom runtime Steam serves.
    "react-dom/client": "ReactDOM",
    "@decky/ui": "DeckyUI",
    "@decky/api": "DeckyApi",
};

export default {
    input: "src/index.tsx",
    external: externals,
    output: {
        file: "dist/index.js",
        format: "iife",
        exports: "named",
        globals,
        sourcemap: true,
    },
    plugins: [
        resolve(),
        commonjs(),
        json(),
        // TSX/TS transform. tsconfig is disabled here so the classic JSX
        // factory below wins over the repo tsconfig's `jsx: "react-jsx"`:
        // the bundle must stay free of a react/jsx-runtime import (Steam
        // serves a global `React`, not the jsx-runtime module), so every
        // JSX file imports `* as React`.
        esbuild({
            target: "es2022",
            jsx: "transform",
            tsconfig: false,
            include: /\.(ts|tsx)$/,
        }),
    ],
};
