import deckyPlugin from "@decky/rollup";

// Decky loads the plugin frontend from dist/index.js (spec §112 Packaging) as
// an ES MODULE: the loader evaluates `const m = await import(url);
// let plugin = m.default();` and provides NO globals of its own. The official
// build contract (decky-plugin-template: `export default deckyPlugin({})`,
// @decky/rollup src/index.js) is therefore owned entirely by the helper:
//
// - output: format "esm" into dist/, sourcemap, exports "default" — the
//   default export must be the callable returned by definePlugin() (@decky/api).
// - externals become PAGE GLOBALS via rollup-plugin-external-globals:
//   react→SP_REACT, react/jsx-runtime→SP_JSX, react-dom→SP_REACTDOM,
//   @decky/ui→DFL, @decky/manifest→inlined plugin.json.
// - @decky/api is NOT external: it is bundled and resolves the loader at
//   runtime via window.__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit.
// - context "window", NODE_ENV=production replace, import-assets publicPath
//   http://127.0.0.1:1337/plugins/<plugin.json name>/, treeshake "smallest"
//   with @decky/ui/@decky/api as pure external imports.
//
// The default export of this file is the merged Rollup options object; the
// callable plugin entry lives in src/index.tsx (definePlugin from @decky/api).
export default deckyPlugin({});
