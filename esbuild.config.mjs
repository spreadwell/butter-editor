import esbuild from "esbuild";
import { builtinModules as builtins } from "module";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  define: {},
  external: [
    "obsidian",
    "electron",
    "@codemirror/state",
    "@codemirror/view",
    "@codemirror/language",
    "@codemirror/commands",
    "@codemirror/search",
    "@codemirror/autocomplete",
    "@codemirror/lint",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    "@lezer/markdown",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  outfile: "main.js",
  sourcemap: false,
  minify: true,
  treeShaking: true,
  platform: "browser",
  logLevel: "info",
});
