import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

const PUBLIC_VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
export const PUBLIC_TSCONFIG = Object.freeze({
  compilerOptions: Object.freeze({
    target: "ES2018",
    module: "ESNext",
    moduleResolution: "node",
    lib: Object.freeze(["ES2018", "DOM"]),
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
    outDir: "./dist",
    sourceMap: true,
    declaration: false,
    noEmitOnError: false,
  }),
  include: Object.freeze(["src/**/*.ts"]),
});

const EXACT_PRIVATE_PATHS = new Set([
  ".github/workflows/release.yml",
  ".github/release-control-hashes.json",
  "LICENSE",
  "README.md",
  "manifest.json",
  "package-lock.json",
  "package.json",
  "styles.css",
  "tsconfig.json",
  "versions.json",
]);
const PRIVATE_PREFIXES = ["assets/", "release-notes/", "src/"];
const DENY_PREFIXES = [
  "src/dev",
  "src/experiments",
  "src/integration/extensions-examples.ts",
];
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".svg",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
]);
const CONTROL_PATHS = new Map([
  ["scripts/build-public-candidate.mjs", ".github/scripts/build-public-candidate.mjs"],
  ["scripts/public-export-shape.mjs", ".github/scripts/public-export-shape.mjs"],
  ["scripts/public-version-history.mjs", ".github/scripts/public-version-history.mjs"],
  ["scripts/verify-public-surface.mjs", ".github/scripts/verify-public-surface.mjs"],
]);
const PUBLIC_EXTERNALS = [
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
];
const PUBLIC_DEV_DEPENDENCIES = new Set([
  "@types/canvas-confetti",
  "@types/markdown-it",
  "esbuild",
  "obsidian",
  "typescript",
]);
const PUBLIC_RUNTIME_DEPENDENCIES = new Set([
  "@codemirror/state",
  "@codemirror/view",
  "canvas-confetti",
  "markdown-it",
  "nanoid",
  "prosemirror-collab",
  "prosemirror-commands",
  "prosemirror-dropcursor",
  "prosemirror-gapcursor",
  "prosemirror-history",
  "prosemirror-inputrules",
  "prosemirror-keymap",
  "prosemirror-model",
  "prosemirror-schema-list",
  "prosemirror-state",
  "prosemirror-tables",
  "prosemirror-transform",
  "prosemirror-view",
]);
const PUBLIC_PACKAGE_KEYS = [
  "dependencies",
  "description",
  "devDependencies",
  "license",
  "main",
  "name",
  "scripts",
  "version",
];
const REGISTRY_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const REGISTRY_SEMVER = /^(?:\^|~)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/u;

// These are character sequences produced when UTF-8 bytes are decoded as
// Windows-1252/Latin-1 and the resulting text is encoded as UTF-8 again.
// Keep the rule specific to high-confidence lead/continuation pairs so normal
// Unicode punctuation (including U+2014 EM DASH) and multilingual prose pass.
const MOJIBAKE_PATTERN = /(?:[\u00C2\u00C3][\u0080-\u00BF]|\u00E2[\u0080-\u00BF\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC\u2013-\u2022\u2030\u2039\u203A\u20AC\u2122]|\u00EF(?:\u00BB|\u00BF)|\u00F0(?:\u009F|\u0178))/u;
const REPLACEMENT_CHARACTER_PATTERN = /\uFFFD/u;
const BIDI_OVERRIDE_OR_ISOLATE_PATTERN = /[\u202A-\u202E\u2066-\u2069]/u;
// U+200C ZERO WIDTH NON-JOINER and U+200D ZERO WIDTH JOINER are deliberately
// absent: they are required by normal language shaping and emoji sequences.
const UNEXPECTED_INVISIBLE_PATTERN = /[\u200B\u2060\uFEFF]/u;

export function publicTextHygieneFindings(value) {
  if (typeof value !== "string") return [];
  const findings = [];
  for (const [code, pattern, message] of [
    ["unicode-mojibake", MOJIBAKE_PATTERN, "probable double-decoded UTF-8/mojibake sequence"],
    ["unicode-replacement-character", REPLACEMENT_CHARACTER_PATTERN, "Unicode replacement character U+FFFD"],
    ["unicode-bidi-control", BIDI_OVERRIDE_OR_ISOLATE_PATTERN, "bidirectional override/isolate control"],
    ["unicode-invisible", UNEXPECTED_INVISIBLE_PATTERN, "unexpected zero-width or in-content BOM character"],
  ]) {
    const match = pattern.exec(value);
    if (match) findings.push({ code, index: match.index, message });
  }
  return findings;
}

function slash(path) {
  return path.replace(/\\/gu, "/");
}

function gitArgs(repoRoot, args) {
  return [
    "-c",
    `safe.directory=${slash(resolve(repoRoot))}`,
    "-c",
    "core.fsmonitor=false",
    "-C",
    resolve(repoRoot),
    ...args,
  ];
}

function scrubbedGitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_/iu.test(key)) delete env[key];
  }
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

function gitBuffer(repoRoot, args) {
  return execFileSync("git", gitArgs(repoRoot, args), {
    encoding: "buffer",
    env: scrubbedGitEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function assertNoGitObjectOverlays(repoRoot) {
  const alternateEnvironment = [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_OBJECT_DIRECTORY",
    "GIT_QUARANTINE_PATH",
  ].filter((key) => process.env[key] !== undefined);
  if (alternateEnvironment.length > 0) {
    throw new Error(`Git alternate-object environment is forbidden for release provenance:\n${alternateEnvironment.join("\n")}`);
  }

  const alternateConfig = gitBuffer(repoRoot, [
    "config",
    "--local",
    "--includes",
    "--name-only",
    "--list",
  ]).toString("utf8").split(/\r?\n/u).filter((key) => (
    /^core\.alternaterefs(?:command|prefixes)$/iu.test(key)
  ));
  if (alternateConfig.length > 0) {
    throw new Error(`Git alternate-ref configuration is forbidden for release provenance:\n${alternateConfig.join("\n")}`);
  }

  for (const name of ["alternates", "http-alternates"]) {
    const pathValue = gitBuffer(repoRoot, [
      "rev-parse",
      "--git-path",
      `objects/info/${name}`,
    ]).toString("utf8").trim();
    const path = isAbsolute(pathValue) ? resolve(pathValue) : resolve(repoRoot, pathValue);
    if (existsSync(path)) {
      throw new Error(`Git object alternates are forbidden for release provenance: ${path}`);
    }
  }

  const replacements = gitBuffer(repoRoot, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/replace",
  ]).toString("utf8").trim();
  if (replacements) throw new Error(`Git replacement refs are forbidden in release repositories:\n${replacements}`);
  const shallow = gitBuffer(repoRoot, ["rev-parse", "--is-shallow-repository"])
    .toString("utf8")
    .trim();
  if (shallow !== "false") throw new Error("Shallow Git repositories are forbidden for release provenance");
  const graftValue = gitBuffer(repoRoot, ["rev-parse", "--git-path", "info/grafts"])
    .toString("utf8")
    .trim();
  const graftPath = isAbsolute(graftValue)
    ? resolve(graftValue)
    : resolve(repoRoot, graftValue);
  if (existsSync(graftPath)) {
    const stats = lstatSync(graftPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== 0) {
      throw new Error(`Git grafts are forbidden for release provenance: ${graftPath}`);
    }
  }
}

export function assertNoDangerousLocalGitConfig(repoRoot) {
  const keys = gitBuffer(repoRoot, [
    "config",
    "--local",
    "--includes",
    "--name-only",
    "--list",
  ]).toString("utf8").split(/\r?\n/u).filter(Boolean);
  const dangerous = keys.filter((key) => /^(?:include(?:if)?\.|url\.|http\.|credential\.|protocol\.|submodule\.|filter\.|core\.(?:alternaterefs(?:command|prefixes)|askpass|attributesfile|fsmonitor|gitproxy|hookspath|sshcommand|worktree)|diff\.|interactive\.difffilter$|merge\..*\.driver|pager\.|remote\.[^.]+\.(?:partialclonefilter|promisor|proxy|receivepack|uploadpack|vcs))/iu.test(key));
  if (dangerous.length > 0) {
    throw new Error(`Transport-affecting local Git configuration is forbidden:\n${dangerous.join("\n")}`);
  }
}

function isDenied(path) {
  return DENY_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function publicPathForPrivate(path) {
  if (CONTROL_PATHS.has(path)) return CONTROL_PATHS.get(path);
  if (EXACT_PRIVATE_PATHS.has(path)) return path;
  if (PRIVATE_PREFIXES.some((prefix) => path.startsWith(prefix)) && !isDenied(path)) return path;
  return "";
}

function safeAsciiPath(path) {
  if (
    !/^[A-Za-z0-9._/-]+$/u.test(path)
    || path.startsWith("/")
    || path.includes("//")
  ) return false;
  return !path.split("/").some((segment) => {
    const base = segment.split(".", 1)[0].toUpperCase();
    return !segment
      || segment === "."
      || segment === ".."
      || segment.endsWith(".")
      || segment.endsWith(" ")
      || segment.toLowerCase() === ".git"
      || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(base);
  });
}

function trackedExportEntries(privateRoot) {
  const raw = gitBuffer(privateRoot, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries = [];
  const publicPaths = new Set();
  let start = 0;
  while (start < raw.length) {
    const end = raw.indexOf(0, start);
    if (end < 0) throw new Error("Private Git tree output is missing a NUL terminator");
    const record = raw.subarray(start, end);
    start = end + 1;
    if (record.length === 0) continue;
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error("Could not parse private Git tree record");
    const header = record.subarray(0, tab).toString("ascii");
    const match = /^(\d+) (\w+) ([0-9a-f]+)$/u.exec(header);
    if (!match) throw new Error(`Could not parse private Git tree header: ${header}`);
    const [, mode, type, object] = match;
    let privatePath;
    try {
      privatePath = decoder.decode(record.subarray(tab + 1));
    } catch {
      throw new Error("Private Git tree contains a non-UTF-8 filename");
    }
    const publicPath = publicPathForPrivate(privatePath);
    if (!publicPath) continue;
    if (type !== "blob" || mode !== "100644") {
      throw new Error(`Public export input has unsupported ${type}/${mode}: ${privatePath}`);
    }
    if (!safeAsciiPath(privatePath) || !safeAsciiPath(publicPath)) {
      throw new Error(`Public export input has a non-portable path: ${privatePath}`);
    }
    const folded = publicPath.toLowerCase();
    if (publicPaths.has(folded)) throw new Error(`Colliding public export path: ${publicPath}`);
    publicPaths.add(folded);
    entries.push({ object, privatePath, publicPath });
  }
  return entries.sort((left, right) => left.publicPath.localeCompare(right.publicPath));
}

function writeBlob(privateRoot, object, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, gitBuffer(privateRoot, ["cat-file", "blob", object]));
}

function writeJson(path, data, indent = 2) {
  writeFileSync(path, `${JSON.stringify(data, null, indent)}\n`);
}

function isPublicTextFile(path) {
  return basename(path) === "LICENSE" || TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}

function normalizePublicTextFiles(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) throw new Error(`Symbolic link in staged public export: ${path}`);
    if (stats.isDirectory()) {
      normalizePublicTextFiles(path);
      continue;
    }
    if (!stats.isFile()) throw new Error(`Non-file in staged public export: ${path}`);
    if (!isPublicTextFile(path)) continue;
    const bytes = readFileSync(path);
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Tracked public text is not valid UTF-8: ${path}`);
    }
    content = content.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
    content = content.replace(/[ \t]+$/gmu, "");
    if (!content.endsWith("\n")) content += "\n";
    writeFileSync(path, content);
  }
}

function exactStringRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([, specifier]) => typeof specifier !== "string")) return null;
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

export function publicPackageMetadataErrors(packageJson, version) {
  const errors = [];
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    return ["package.json must contain one JSON object"];
  }
  if (JSON.stringify(Object.keys(packageJson).sort()) !== JSON.stringify(PUBLIC_PACKAGE_KEYS)) {
    errors.push("package.json fields must match the fixed public allowlist exactly");
  }
  if (
    packageJson.name !== "butter-editor"
    || packageJson.version !== version
    || packageJson.main !== "main.js"
    || packageJson.license !== "UNLICENSED"
    || typeof packageJson.description !== "string"
    || packageJson.description.trim() === ""
  ) errors.push("package identity, version, entry point, license, or description is invalid");
  for (const finding of publicTextHygieneFindings(packageJson.description)) {
    errors.push(`package description contains ${finding.message}`);
  }
  if (
    !packageJson.scripts
    || typeof packageJson.scripts !== "object"
    || Array.isArray(packageJson.scripts)
    || JSON.stringify(packageJson.scripts) !== JSON.stringify({ build: "node esbuild.config.mjs production" })
  ) errors.push("package scripts must contain only the fixed public build command");

  for (const [field, allowed] of [
    ["dependencies", PUBLIC_RUNTIME_DEPENDENCIES],
    ["devDependencies", PUBLIC_DEV_DEPENDENCIES],
  ]) {
    const record = exactStringRecord(packageJson[field]);
    if (!record) {
      errors.push(`${field} must be a plain string-to-string record`);
      continue;
    }
    const unexpected = Object.keys(record).filter((name) => !allowed.has(name));
    if (unexpected.length > 0) {
      errors.push(`${field} contains names outside the audited public dependency allowlist: ${unexpected.join(", ")}`);
    }
    if (
      field === "devDependencies"
      && ["esbuild", "typescript"].some((required) => !Object.hasOwn(record, required))
    ) {
      errors.push("devDependencies must include esbuild and typescript");
    }
    for (const [name, specifier] of Object.entries(record)) {
      if (
        name.length > 214
        || !REGISTRY_PACKAGE_NAME.test(name)
        || (!REGISTRY_SEMVER.test(specifier) && !(field === "devDependencies" && name === "obsidian" && specifier === "latest"))
      ) {
        errors.push(`${field}.${name} is not an approved registry package and canonical semver range`);
      }
    }
  }
  return errors;
}

export function assertSafePublicPackageMetadata(packageJson, version) {
  const errors = publicPackageMetadataErrors(packageJson, version);
  if (errors.length > 0) {
    throw new Error(`Unsafe public package metadata was rejected before package resolution:\n${errors.join("\n")}`);
  }
}

export function publicLockMetadataErrors(packageLock, version) {
  const errors = [];
  if (!packageLock || typeof packageLock !== "object" || Array.isArray(packageLock)) {
    return ["package-lock.json must contain one JSON object"];
  }
  if (
    JSON.stringify(Object.keys(packageLock).sort())
      !== JSON.stringify(["lockfileVersion", "name", "packages", "requires", "version"])
    || packageLock.name !== "butter-editor"
    || packageLock.version !== version
    || packageLock.lockfileVersion !== 3
    || packageLock.requires !== true
    || !packageLock.packages
    || typeof packageLock.packages !== "object"
    || Array.isArray(packageLock.packages)
  ) errors.push("package lock top-level metadata must match the fixed npm v3 schema");
  const root = packageLock.packages?.[""];
  if (
    !root
    || typeof root !== "object"
    || Array.isArray(root)
    || JSON.stringify(Object.keys(root).sort())
      !== JSON.stringify(["dependencies", "devDependencies", "license", "name", "version"])
    || root.name !== "butter-editor"
    || root.version !== version
    || root.license !== "UNLICENSED"
  ) errors.push("package lock root metadata must match the fixed public package identity");
  for (const field of ["dependencies", "devDependencies"]) {
    const record = exactStringRecord(root?.[field]);
    if (!record) {
      errors.push(`package lock root ${field} must be a string-to-string record`);
      continue;
    }
    for (const [name, specifier] of Object.entries(record)) {
      if (name.length > 214 || !REGISTRY_PACKAGE_NAME.test(name) || (!REGISTRY_SEMVER.test(specifier) && specifier !== "latest")) {
        errors.push(`package lock root ${field}.${name} is not a safe registry request`);
      }
    }
  }
  for (const [path, entry] of Object.entries(packageLock.packages ?? {})) {
    if (!path) continue;
    if (
      !/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/u.test(path)
      || !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || typeof entry.resolved !== "string"
      || !entry.resolved.startsWith("https://registry.npmjs.org/")
      || typeof entry.integrity !== "string"
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity)
      || entry.link === true
    ) errors.push(`package lock contains an unsafe resolution at ${path}`);
  }
  return errors;
}

export function assertSafePublicLockMetadata(packageLock, version) {
  const errors = publicLockMetadataErrors(packageLock, version);
  if (errors.length > 0) {
    throw new Error(`Unsafe public lock metadata was rejected before package resolution:\n${errors.join("\n")}`);
  }
}

export function publicEsbuildConfig() {
  return `import esbuild from "esbuild";
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
  tsconfigRaw: ${JSON.stringify(PUBLIC_TSCONFIG, null, 2)},
  platform: "browser",
  logLevel: "info",
});
`;
}

export function publicEsbuildOptions(root) {
  return {
    absWorkingDir: resolve(root),
    bundle: true,
    define: {},
    entryPoints: ["src/main.ts"],
    external: [...PUBLIC_EXTERNALS, ...builtinModules],
    format: "cjs",
    logLevel: "info",
    minify: true,
    outfile: "main.js",
    platform: "browser",
    sourcemap: false,
    target: "es2018",
    treeShaking: true,
    tsconfigRaw: {
      compilerOptions: {
        ...PUBLIC_TSCONFIG.compilerOptions,
        lib: [...PUBLIC_TSCONFIG.compilerOptions.lib],
      },
      include: [...PUBLIC_TSCONFIG.include],
    },
  };
}

function npmInvocation(args, cwd) {
  if (process.env.BTR_WDM_EXE && process.env.BTR_WDM_ROOT) {
    const root = resolve(process.env.BTR_WDM_ROOT);
    const workingDirectory = relative(root, resolve(cwd));
    if (!workingDirectory || workingDirectory.startsWith("..") || isAbsolute(workingDirectory)) {
      throw new Error("Public lock regeneration escaped the trusted WDM root");
    }
    return {
      command: resolve(process.env.BTR_WDM_EXE),
      args: ["deps", "run", "npm", "--cwd", workingDirectory.replace(/\\/gu, "/"), ...args],
    };
  }
  throw new Error("Public lock regeneration requires the trusted WDM release launcher");
}

function regeneratePublicLock(destination, environment) {
  const invocation = npmInvocation([
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--legacy-peer-deps",
    "--no-audit",
    "--no-fund",
  ], destination);
  execFileSync(invocation.command, invocation.args, {
    cwd: destination,
    env: environment ?? process.env,
    stdio: "inherit",
  });
}

export function createPublicExport({
  destination,
  npmEnvironment,
  privateRoot,
  regenerateLock = false,
  version,
}) {
  if (!PUBLIC_VERSION_RE.test(version)) throw new Error("Public export requires canonical bare semver");
  assertNoGitObjectOverlays(privateRoot);
  mkdirSync(destination, { recursive: true });
  for (const entry of trackedExportEntries(privateRoot)) {
    writeBlob(privateRoot, entry.object, join(destination, ...entry.publicPath.split("/")));
  }

  const generatedMain = join(privateRoot, "main.js");
  const mainStats = lstatSync(generatedMain);
  if (!mainStats.isFile() || mainStats.isSymbolicLink()) {
    throw new Error("Generated private main.js must be a regular file");
  }
  writeFileSync(join(destination, "main.js"), readFileSync(generatedMain));
  writeFileSync(join(destination, "esbuild.config.mjs"), publicEsbuildConfig());

  const manifestPath = join(destination, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = version;
  writeJson(manifestPath, manifest, "\t");

  const packagePath = join(destination, "package.json");
  const privatePackage = JSON.parse(readFileSync(packagePath, "utf8"));
  const packageJson = {
    name: privatePackage.name,
    version,
    description: privatePackage.description,
    main: privatePackage.main,
    license: privatePackage.license,
    scripts: { build: "node esbuild.config.mjs production" },
    dependencies: privatePackage.dependencies ?? {},
    devDependencies: Object.fromEntries(
      Object.entries(privatePackage.devDependencies ?? {})
      .filter(([name]) => PUBLIC_DEV_DEPENDENCIES.has(name)),
    ),
  };
  assertSafePublicPackageMetadata(packageJson, version);
  writeJson(packagePath, packageJson);

  const lockPath = join(destination, "package-lock.json");
  const lock = readFileSync(lockPath, "utf8").replace(
    /("name"\s*:\s*"butter-editor"\s*,\s*\n\s*"version"\s*:\s*")[^"]+(")/gu,
    `$1${version}$2`,
  );
  if (regenerateLock) assertSafePublicLockMetadata(JSON.parse(lock), version);
  writeFileSync(lockPath, lock);

  const versionsPath = join(destination, "versions.json");
  const versions = JSON.parse(readFileSync(versionsPath, "utf8"));
  versions[version] = manifest.minAppVersion;
  writeJson(versionsPath, versions);

  if (regenerateLock) regeneratePublicLock(destination, npmEnvironment);

  normalizePublicTextFiles(destination);
  return snapshotTree(destination);
}

export function snapshotTree(root, relativePath = "", result = new Map()) {
  const absolute = relativePath ? join(root, ...relativePath.split("/")) : root;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (!relativePath && entry.name === "node_modules") continue;
    const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const child = join(absolute, entry.name);
    const stats = lstatSync(child);
    if (stats.isSymbolicLink()) throw new Error(`Symbolic link in public tree: ${childRelative}`);
    if (stats.isDirectory()) snapshotTree(root, childRelative, result);
    else if (stats.isFile()) {
      result.set(childRelative, createHash("sha256").update(readFileSync(child)).digest("hex"));
    } else throw new Error(`Non-file in public tree: ${childRelative}`);
  }
  return result;
}

export function firstTreeDifference(expected, actual) {
  const paths = new Set([...expected.keys(), ...actual.keys()]);
  for (const path of [...paths].sort()) {
    if (expected.get(path) !== actual.get(path)) return path;
  }
  return "";
}
