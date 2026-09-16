import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";

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
  "@decky/ui": "DeckyUI",
  "@decky/api": "DeckyApi",
};

export default {
  input: "src/index.tsx",
  external: externals,
  output: {
    file: "dist/index.js",
    format: "iife",
    globals,
    sourcemap: true,
  },
  plugins: [resolve(), commonjs(), json()],
};
