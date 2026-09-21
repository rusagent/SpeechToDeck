import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import esbuild from "rollup-plugin-esbuild";

const externals = (id) =>
    ["react", "react-dom", "@decky/ui"].some((dep) => id === dep || id.startsWith(`${dep}/`));

const globals = {
    react: "React",
    "react-dom": "ReactDOM",
    "react-dom/client": "ReactDOM",
    "@decky/ui": "DeckyUI",
};

export default {
    input: "tests/visual/harness-entry.tsx",
    external: externals,
    output: {
        file: "tests/visual/dist/bundle.js",
        format: "iife",
        exports: "named",
        globals,
        sourcemap: false,
    },
    plugins: [
        resolve(),
        commonjs(),
        esbuild({
            target: "es2022",
            jsx: "transform",
            tsconfig: false,
            include: /\.(ts|tsx)$/,
        }),
    ],
};
