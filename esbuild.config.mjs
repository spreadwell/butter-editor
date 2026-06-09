import esbuild from "esbuild";
import { builtinModules as builtins } from "module";
import { copyFileSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const prod = process.argv[2] === "production";
// `once` mode: build once in DEV flavor (so the vault manifest is
// stamped DEV and phone push fires), then exit instead of starting
// the watcher. Lets the agent iterate without holding a watcher open.
const onceMode = process.argv[2] === "once";
// Derive the plugin ID from manifest.json so the auto-copy path
// stays correct after a rename (no hardcoded plugin folder name).
const PLUGIN_ID = JSON.parse(
  readFileSync(resolve(__dirname, "manifest.json"), "utf8"),
).id;
const vaultPluginDir = resolve(
  __dirname,
  `../btr-dev-vault/.obsidian/plugins/${PLUGIN_ID}`,
);

// Only mirror builds into the dev test vault when it actually exists
// (the dev monorepo). On a source-available public clone the vault is
// absent — skip all vault I/O so `npm run build` just emits main.js
// without creating stray folders outside the user's checkout.
const hasTestVault = existsSync(resolve(__dirname, "../btr-dev-vault"));

if (hasTestVault && !existsSync(vaultPluginDir)) mkdirSync(vaultPluginDir, { recursive: true });

// Re-evaluated on every build so a version bump during a running
// watcher is picked up and stamped into the vault manifest.
let SOURCE_MANIFEST = JSON.parse(
  readFileSync(resolve(__dirname, "manifest.json"), "utf8"),
);

const refreshManifest = {
  name: "refresh-manifest",
  setup(build) {
    // onStart fires at the beginning of EVERY build, initial and each
    // watch-mode rebuild. Re-read manifest.json so a mid-watch version
    // bump (or hand-edit) is stamped into the vault manifest.
    build.onStart(() => {
      if (prod) return;
      SOURCE_MANIFEST = JSON.parse(
        readFileSync(resolve(__dirname, "manifest.json"), "utf8"),
      );
      console.log(`→ dev build ${SOURCE_MANIFEST.version}`);
    });
  },
};

const copyToVault = {
  name: "copy-to-vault",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      if (!hasTestVault) return;
      copyFileSync(resolve(__dirname, "main.js"), resolve(vaultPluginDir, "main.js"));

      // Dev: write a modified manifest into the vault so Obsidian
      // displays "Butter Editor (DEV)" at version `X.Y.Z-N` — visibly
      // distinct from any BRAT-installed copy. Source manifest.json
      // on disk stays clean at the release version.
      // Prod: straight copy.
      const destManifest = resolve(vaultPluginDir, "manifest.json");
      if (prod) {
        copyFileSync(resolve(__dirname, "manifest.json"), destManifest);
      } else {
        // Dev vault manifest mirrors the source version verbatim. The
        // version label is bumped by hand each build, so it is itself
        // the reload fingerprint. No tag or counter suffix is appended.
        const vaultManifest = {
          ...SOURCE_MANIFEST,
          name: `${SOURCE_MANIFEST.name} (DEV)`,
          version: SOURCE_MANIFEST.version,
        };
        writeFileSync(destManifest, JSON.stringify(vaultManifest, null, 2) + "\n");
      }

      const srcStyles = resolve(__dirname, "styles.css");
      if (existsSync(srcStyles)) {
        if (prod) {
          const css = readFileSync(srcStyles, "utf8");
          const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\n{3,}/g, "\n\n").trim() + "\n";
          writeFileSync(resolve(vaultPluginDir, "styles.css"), stripped);
        } else {
          copyFileSync(srcStyles, resolve(vaultPluginDir, "styles.css"));
        }
      }
      console.log(`→ copied to ${vaultPluginDir}`);
    });
  },
};

async function loadDevicesConfig() {
  const configPath = resolve(__dirname, "devices.local.mjs");
  if (!existsSync(configPath)) return [];
  try {
    const mod = await import(`file://${configPath.replace(/\\/g, "/")}`);
    return mod.default ?? [];
  } catch (err) {
    console.warn(`devices: skipping (failed to load config: ${err.message})`);
    return [];
  }
}

function pushDevice(device, sourceDir) {
  const psBase = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass"];

  if (device.type === "adb") {
    const script = resolve(__dirname, "scripts", "push-to-phone.ps1");
    const ps = spawn(psBase[0], [
      ...psBase.slice(1), "-File", script,
      "-AdbExe", device.adbExe,
      "-VaultPath", device.vaultPath || `/sdcard/Documents/btr-dev-vault`,
      "-PluginId", PLUGIN_ID,
      "-SourceDir", sourceDir,
    ], { stdio: ["ignore", "inherit", "inherit"] });
    ps.on("error", () => {});
  } else if (device.type === "icloud") {
    const pluginDir = resolve(device.vaultPath, `.obsidian/plugins/${PLUGIN_ID}`);
    try {
      if (!existsSync(pluginDir)) mkdirSync(pluginDir, { recursive: true });
      for (const f of ["main.js", "manifest.json", "styles.css"]) {
        const src = resolve(sourceDir, f);
        if (existsSync(src)) copyFileSync(src, resolve(pluginDir, f));
      }
      console.log(`→ pushed to ${device.name} (iCloud)`);
    } catch (err) {
      console.warn(`→ ${device.name}: iCloud push skipped (${err.message})`);
    }
  } else if (device.type === "ssh") {
    const script = resolve(__dirname, "scripts", "push-ssh.ps1");
    const args = [
      ...psBase.slice(1), "-File", script,
      "-SshHost", device.host,
      "-KeyPath", device.keyPath.startsWith("/") || device.keyPath.includes(":") ? device.keyPath : resolve(__dirname, device.keyPath),
      "-VaultPath", device.vaultPath || "~/btr-dev-vault",
      "-SourceDir", sourceDir,
    ];
    if (device.sshOptions) args.push("-SshOptions", device.sshOptions.join(","));
    const ps = spawn(psBase[0], args, { stdio: ["ignore", "inherit", "inherit"] });
    ps.on("error", () => {});
  }
  // "local" type is handled by copyToVault — no extra push needed
}

const pushToDevices = {
  name: "push-to-devices",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      if (prod) return;
      const devices = await loadDevicesConfig();
      for (const device of devices) {
        if (device.type === "local") continue;
        pushDevice(device, vaultPluginDir);
      }
    });
  },
};

const config = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  define: {},
  external: [
    "obsidian",
    "electron",
    // CRITICAL: CM6 / Lezer packages must come from Obsidian's runtime,
    // not be bundled. Bundling creates a second copy whose classes fail
    // the instanceof checks Obsidian-registered extensions use — the
    // CM6 bridge would reject every external extension otherwise.
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
  sourcemap: prod ? false : "inline",
  // Production: minify + strip dead code (turns `if (false) { … }` into
  // nothing, removing dev-gated branches entirely from the bundle).
  // Also reduces download size and makes the closed-source bundle
  // harder to read. Dev keeps readable output for stack traces.
  minify: prod,
  treeShaking: true,
  platform: "browser",
  logLevel: "info",
  // Order matters: refreshManifest re-reads the version before
  // copyToVault writes the vault manifest. pushToPhone runs last and
  // reads from the vault dir, picking up the fresh manifest.
  plugins: [refreshManifest, copyToVault, pushToDevices],
};

if (prod || onceMode) {
  await esbuild.build(config);
} else {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  console.log("watching...");

  // esbuild's watch only follows imports from src/main.ts. styles.css
  // and manifest.json aren't in that graph but are shipped to the
  // vault — without explicit watchers, edits to them don't trigger a
  // rebuild, the dev-build counter doesn't increment, and the change
  // never lands on the device. Watch those files manually and call
  // ctx.rebuild() on any change.
  const assetWatchPaths = [
    resolve(__dirname, "styles.css"),
    resolve(__dirname, "manifest.json"),
  ];
  for (const p of assetWatchPaths) {
    if (!existsSync(p)) continue;
    let pending = false;
    watch(p, () => {
      // Debounce — `fs.watch` fires twice on many editors (write +
      // rename-temp). Coalesce to a single rebuild.
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        ctx.rebuild().catch(() => {});
      }, 50);
    });
  }
}
