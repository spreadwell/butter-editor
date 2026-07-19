#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, extname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  publicPackageMetadataErrors,
  publicTextHygieneFindings,
} from "./public-export-shape.mjs";
import { validatePublishedVersionHistory } from "./public-version-history.mjs";

export const PUBLIC_TOP_LEVEL = new Set([
  ".github",
  "LICENSE",
  "README.md",
  "assets",
  "esbuild.config.mjs",
  "main.js",
  "manifest.json",
  "package-lock.json",
  "package.json",
  "release-notes",
  "src",
  "styles.css",
  "tsconfig.json",
  "versions.json",
]);

const PUBLIC_DIRECTORIES = new Set([
  ".github",
  "assets",
  "release-notes",
  "src",
]);

const REQUIRED_PATHS = [
  ".github/scripts/build-public-candidate.mjs",
  ".github/scripts/public-export-shape.mjs",
  ".github/scripts/public-version-history.mjs",
  ".github/scripts/verify-public-surface.mjs",
  ".github/release-control-hashes.json",
  ".github/workflows/release.yml",
  "LICENSE",
  "README.md",
  "assets/btr-blocks.gif",
  "assets/btr-color.gif",
  "assets/btr-custom-toolbar.gif",
  "assets/btr-markdown-formatting.gif",
  "esbuild.config.mjs",
  "main.js",
  "manifest.json",
  "package-lock.json",
  "package.json",
  "src/main.ts",
  "styles.css",
  "tsconfig.json",
  "versions.json",
];

const PUBLIC_BUILD_SCRIPT = "node esbuild.config.mjs production";
const PUBLIC_VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
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
const PUBLIC_TSCONFIG = {
  compilerOptions: {
    target: "ES2018",
    module: "ESNext",
    moduleResolution: "node",
    lib: ["ES2018", "DOM"],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
    outDir: "./dist",
    sourceMap: true,
    declaration: false,
    noEmitOnError: false,
  },
  include: ["src/**/*.ts"],
};

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".svg",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const PUBLIC_ASSET_PATHS = new Set([
  "assets/btr-blocks.gif",
  "assets/btr-color.gif",
  "assets/btr-custom-toolbar.gif",
  "assets/btr-markdown-formatting.gif",
]);

const PUBLIC_DEV_DEPENDENCIES = new Set([
  "@types/canvas-confetti",
  "@types/markdown-it",
  "esbuild",
  "obsidian",
  "typescript",
]);
const LOCAL_CONTROL_KEYS = [
  "candidateVerifier",
  "publicExporter",
  "releaseOrchestrator",
];

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const BARE_SOURCE_SPECIFIER = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)*$/u;

const SELF_RULE_DEFINITION_PATHS = new Set([
  ".github/scripts/verify-public-surface.mjs",
]);

// verifier-rule-definitions:start
const PRIVATE_PATH_PATTERNS = [
  /(?:^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._-]+[\\/][A-Za-z0-9$._-]+[\\/])[^\r\n"'`]{1,260}/u,
  /(?:^|[\\/])(?:workdirs?|worktrees?|workspace)(?:[\\/]|$)/iu,
  /\b[a-z0-9][a-z0-9-]*-(?:private|license-worker|dev-tools|test-driver|dev-vault|release-vault)\b/iu,
  /(?:^|[\\/])\.(?:agents?|worktree|workspace)(?:[\\/]|$)/iu,
  /\b(?:AGENTS|CLAUDE)\.md\b/iu,
];

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\b(?:sk_(?:live|test)|rk_live|whsec)_[A-Za-z0-9]{16,}\b/u,
  /\bpolar_(?:oat|pat)_[A-Za-z0-9_-]{16,}\b/iu,
  /\bre_[A-Za-z0-9]{24,}\b/u,
  /\bBTR-[A-Z]-[A-Za-z0-9_-]{12,}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /\bAuthorization\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._~+\/-]{12,}/iu,
  /["']?(?:access[_-]?token|refresh[_-]?token|session[_-]?(?:id|token)|cookie)["']?\s*[:=]\s*["'][^"'`\s]{12,}["']/iu,
  /["']?(?:CLOUDFLARE_API_TOKEN|POLAR_ACCESS_TOKEN|RESEND_API_KEY|STRIPE_SECRET_KEY|WEBHOOK_SECRET)["']?\s*[:=]\s*["'][^"'`\s]{12,}["']/iu,
];
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/giu;

const HUMAN_MARKERS = [
  {
    code: "ai-marker",
    pattern: /\b(?:ChatGPT|OpenAI|Claude|Codex|Gemini|GitHub Copilot)\b/iu,
    message: "AI/model name in public prose or a source comment",
  },
  {
    code: "internal-codename",
    pattern: /\bPMX\b/u,
    message: "private PMX codename in public prose or a source comment",
  },
  {
    code: "process-marker",
    pattern: /\b(?:review attempt|release[- ]prep|Obsidian preview review|review scanner|scanner warning|agent[- ]process|owner-authored|AI\/process)\b/iu,
    message: "internal release/review process language",
  },
  {
    code: "unfinished-marker",
    pattern: /\b(?:TBD|FIXME|HACK|XXX|design pending)\b/iu,
    message: "unfinished-work marker in public prose or a source comment",
  },
  {
    code: "unfinished-marker",
    pattern: /\bTODO\b(?:\s*[:\-]|\s+(?:remove|fix|implement|finish|cleanup|clean up)\b)/iu,
    message: "unfinished TODO in public prose or a source comment",
  },
  {
    code: "release-note-template",
    pattern: /Customer-facing notes for|Lead with user impact|3\s*(?:-|\u2013)\s*6 short bullets/iu,
    message: "release-note authoring template leaked into the public tree",
  },
];

const LOCAL_BACKEND_URL_PATTERN = /https?:\/\/(?:localhost|0\.0\.0\.0|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|host\.docker\.internal|(?:[A-Z0-9-]+\.)*[A-Z0-9-]+\.local|\[::1\])(?::\d{1,5})?(?![A-Z0-9.-])/iu;

const DEV_HOOK_PATTERNS = [
  {
    pattern: /\bforceLicenseState\b/u,
    message: "fake-license state hook is present in production source",
  },
  {
    pattern: /\bfake license(?:-settings| state)?\b/iu,
    message: "fake-license state hook is present in production source",
  },
  {
    pattern: /\b(?:reset|grant|force)(?:Trial|License|Entitlement)\b/u,
    message: "trial/license grant or reset hook is present in production source",
  },
  {
    pattern: /\b(?:api|checkout|license)(?:Base)?(?:Url|URL)Override\b/u,
    message: "backend or checkout URL override is present in production source",
  },
  {
    pattern: LOCAL_BACKEND_URL_PATTERN,
    message: "local backend URL is present in production source",
  },
  {
    pattern: /\b(?:adminBypass|debugLicense|testUser|testDeviceId)\b/u,
    message: "test/admin/debug identity hook is present in production source",
  },
];

const BUNDLE_BYPASS_PATTERNS = [
  /\bforceLicenseState\b/u,
  /\b__BUTTER_DEV__\b/u,
  /\b(?:fake|mock|bypass|skip)[A-Z_-]?License\b/iu,
  /\blicense[A-Z_-]?(?:bypass|override)\b/iu,
  /\b(?:reset|grant|force)(?:Trial|License|Entitlement)\b/u,
  /\b(?:api|checkout|license)(?:Base)?(?:Url|URL)Override\b/u,
  LOCAL_BACKEND_URL_PATTERN,
  /\b(?:adminBypass|debugLicense|testUser|testDeviceId)\b/u,
];
// verifier-rule-definitions:end

function slash(path) {
  return path.replace(/\\/gu, "/");
}

function lineAt(content, index) {
  return content.slice(0, Math.max(0, index)).split("\n").length;
}

function makeFinding(code, file, line, message) {
  return { code, file: slash(file), line, message };
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

function exactGit(repoRoot, args, encoding = "buffer") {
  return execFileSync("git", [
    "-c",
    `safe.directory=${slash(resolve(repoRoot))}`,
    "-c",
    "core.fsmonitor=false",
    "-C",
    resolve(repoRoot),
    ...args,
  ], {
    encoding,
    env: scrubbedGitEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function portableGitPath(path, seen) {
  if (
    path !== posix.normalize(path)
    || !/^[A-Za-z0-9._/-]+$/u.test(path)
    || posix.isAbsolute(path)
    || path === ".."
    || path.startsWith("../")
  ) return false;
  for (const segment of path.split("/")) {
    const base = segment.split(".", 1)[0].toUpperCase();
    if (
      !segment
      || segment.endsWith(".")
      || segment.endsWith(" ")
      || segment.toLowerCase() === ".git"
      || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(base)
    ) return false;
  }
  const folded = path.toLowerCase();
  if (seen.has(folded)) return false;
  seen.add(folded);
  return true;
}

function checkoutSnapshot(root) {
  const files = new Map();
  const directories = new Set();
  const visit = (relativePath = "") => {
    const absolute = relativePath ? join(root, ...relativePath.split("/")) : root;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!relativePath && entry.name === ".git") continue;
      const path = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const stats = lstatSync(join(absolute, entry.name));
      if (stats.isSymbolicLink()) throw new Error(`checkout contains a symbolic link: ${path}`);
      if (stats.isDirectory()) {
        directories.add(path);
        visit(path);
      } else if (stats.isFile()) {
        files.set(path, createHash("sha256").update(readFileSync(join(absolute, entry.name))).digest("hex"));
      } else throw new Error(`checkout contains a non-file entry: ${path}`);
    }
  };
  visit();
  return { directories, files };
}

export function verifyGitTree({ commit, repoRoot, root = repoRoot }) {
  const findings = [];
  if (!/^[0-9a-f]{40}$/u.test(commit ?? "")) {
    return [makeFinding("git-tree-commit", "<git>", 1, "commit must be a full lowercase SHA-1")];
  }
  try {
    const exactCommit = exactGit(repoRoot, ["rev-parse", "--verify", `${commit}^{commit}`], "utf8").trim();
    if (exactCommit !== commit) throw new Error("commit does not resolve to the exact supplied object");
    const replacements = exactGit(repoRoot, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/replace",
    ], "utf8").trim();
    if (replacements) throw new Error("Git replacement refs are present");
    const graftPath = exactGit(repoRoot, ["rev-parse", "--git-path", "info/grafts"], "utf8").trim();
    const absoluteGraft = resolve(repoRoot, graftPath);
    if (existsSync(absoluteGraft)) {
      const graftStats = lstatSync(absoluteGraft);
      if (!graftStats.isFile() || graftStats.isSymbolicLink() || graftStats.size !== 0) {
        throw new Error("Git grafts are present");
      }
    }

    const raw = exactGit(repoRoot, ["ls-tree", "-r", "-t", "-z", "--full-tree", commit]);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const seen = new Set();
    const trees = new Set();
    const blobs = new Map();
    for (const record of text.split("\0").filter(Boolean)) {
      const tab = record.indexOf("\t");
      const match = /^(\d+) (\w+) ([0-9a-f]{40})$/u.exec(record.slice(0, tab));
      const path = record.slice(tab + 1);
      if (tab < 0 || !match) throw new Error(`unparsable Git tree record: ${record}`);
      if (!portableGitPath(path, seen)) {
        findings.push(makeFinding("git-tree-path", path || "<git>", 1, "unsafe, non-portable, or case-colliding Git path"));
        continue;
      }
      const [, mode, type, object] = match;
      if (type === "tree" && mode === "040000") trees.add(path);
      else if (type === "blob" && mode === "100644") {
        blobs.set(path, {
          hash: createHash("sha256").update(exactGit(repoRoot, ["cat-file", "blob", object])).digest("hex"),
        });
      } else {
        findings.push(makeFinding("git-tree-entry", path, 1, `unsupported Git entry ${type}/${mode}`));
      }
    }
    for (const tree of trees) {
      if (![...blobs.keys()].some((path) => path.startsWith(`${tree}/`))) {
        findings.push(makeFinding("git-empty-tree", tree, 1, "Git tree has no validated descendant blob"));
      }
    }

    const checkout = checkoutSnapshot(resolve(root));
    const expectedFiles = [...blobs.keys()].sort();
    const actualFiles = [...checkout.files.keys()].sort();
    const expectedDirectories = [...trees].sort();
    const actualDirectories = [...checkout.directories].sort();
    if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
      findings.push(makeFinding("git-checkout-parity", "<git>", 1, "checkout file paths differ from the exact Git tree"));
    }
    if (JSON.stringify(expectedDirectories) !== JSON.stringify(actualDirectories)) {
      findings.push(makeFinding("git-checkout-parity", "<git>", 1, "checkout directory paths differ from the exact Git tree"));
    }
    for (const [path, { hash }] of blobs) {
      if (checkout.files.get(path) !== hash) {
        findings.push(makeFinding("git-checkout-parity", path, 1, "checkout bytes differ from the exact Git blob"));
      }
    }
  } catch (error) {
    findings.push(makeFinding(
      "git-tree-inspection",
      "<git>",
      1,
      error instanceof Error ? error.message : String(error),
    ));
  }
  return findings;
}

function knownFile(relativePath) {
  if (relativePath.startsWith("src/")) {
    return /\.(?:d\.)?tsx?$/u.test(relativePath);
  }
  if (relativePath.startsWith("release-notes/")) {
    return /^release-notes\/(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.md$/u.test(relativePath);
  }
  if (relativePath.startsWith("assets/")) {
    return PUBLIC_ASSET_PATHS.has(relativePath);
  }
  if (relativePath.startsWith(".github/")) {
    return relativePath === ".github/workflows/release.yml"
      || relativePath === ".github/scripts/build-public-candidate.mjs"
      || relativePath === ".github/scripts/public-export-shape.mjs"
      || relativePath === ".github/scripts/public-version-history.mjs"
      || relativePath === ".github/scripts/verify-public-surface.mjs"
      || relativePath === ".github/release-control-hashes.json";
  }
  return PUBLIC_TOP_LEVEL.has(relativePath);
}

function walkKnownDirectory(root, relativeDir, findings, files) {
  const absoluteDir = join(root, ...relativeDir.split("/"));
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const absolutePath = join(absoluteDir, entry.name);
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      findings.push(makeFinding(
        "public-symlink",
        relativePath,
        1,
        "symbolic links are not allowed in the public package",
      ));
      continue;
    }
    if (entry.isDirectory()) {
      if (
        relativeDir === "release-notes"
        || relativeDir === ".github/workflows"
        || relativeDir === ".github/scripts"
      ) {
        findings.push(makeFinding(
          "public-allowlist",
          relativePath,
          1,
          "unexpected directory in a constrained public path",
        ));
        continue;
      }
      if (
        relativeDir === ".github"
        && entry.name !== "workflows"
        && entry.name !== "scripts"
      ) {
        findings.push(makeFinding(
          "public-allowlist",
          relativePath,
          1,
          "only the exact trusted release controls are allowed under .github",
        ));
        continue;
      }
      walkKnownDirectory(root, relativePath, findings, files);
      continue;
    }
    if (!entry.isFile() || !knownFile(relativePath)) {
      findings.push(makeFinding(
        "public-allowlist",
        relativePath,
        1,
        "file is outside the known public package shape",
      ));
      continue;
    }
    files.push(relativePath);
  }
}

function inspectTree(root, findings) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const relativePath = entry.name;
    if (!PUBLIC_TOP_LEVEL.has(relativePath)) {
      findings.push(makeFinding(
        "public-allowlist",
        relativePath,
        1,
        "unexpected top-level public path",
      ));
      continue;
    }
    const absolutePath = join(root, entry.name);
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      findings.push(makeFinding(
        "public-symlink",
        relativePath,
        1,
        "symbolic links are not allowed in the public package",
      ));
      continue;
    }
    if (entry.isDirectory()) {
      if (!PUBLIC_DIRECTORIES.has(relativePath)) {
        findings.push(makeFinding(
          "public-allowlist",
          relativePath,
          1,
          "public file path is unexpectedly a directory",
        ));
        continue;
      }
      walkKnownDirectory(root, relativePath, findings, files);
    } else if (entry.isFile() && !PUBLIC_DIRECTORIES.has(relativePath) && knownFile(relativePath)) {
      files.push(relativePath);
    } else {
      findings.push(makeFinding(
        "public-allowlist",
        relativePath,
        1,
        "public path has the wrong type",
      ));
    }
  }
  return files.sort();
}

function readPublicFile(root, relativePath) {
  const bytes = readFileSync(join(root, ...relativePath.split("/")));
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error("UTF-8 BOM is not allowed");
  }
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("file is not valid UTF-8");
  }
  const prohibitedControls = relativePath === "main.js"
    ? /[\u0000\u007f]/u
    : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
  if (prohibitedControls.test(content)) {
    throw new Error("file contains prohibited control characters");
  }
  return content;
}

function scanPublicPath(relativePath, findings) {
  for (const pattern of PRIVATE_PATH_PATTERNS) {
    if (pattern.test(relativePath)) {
      findings.push(makeFinding("private-path", relativePath, 1, "private marker in public filename"));
    }
  }
  for (const marker of HUMAN_MARKERS) {
    if (marker.pattern.test(relativePath)) {
      findings.push(makeFinding(marker.code, relativePath, 1, `${marker.message} in filename`));
    }
  }
}

function inspectBinaryAsset(root, relativePath, findings) {
  const bytes = readFileSync(join(root, ...relativePath.split("/")));
  const header = bytes.subarray(0, 6).toString("ascii");
  const width = bytes.length >= 10 ? bytes.readUInt16LE(6) : 0;
  const height = bytes.length >= 10 ? bytes.readUInt16LE(8) : 0;
  if (
    bytes.length < 14
    || bytes.length > 20 * 1024 * 1024
    || (header !== "GIF87a" && header !== "GIF89a")
    || bytes.at(-1) !== 0x3b
    || width < 1
    || height < 1
    || width > 4096
    || height > 4096
  ) {
    findings.push(makeFinding(
      "invalid-public-asset",
      relativePath,
      1,
      "GIF signature, dimensions, size, or terminator is invalid",
    ));
    return;
  }
  const metadata = [];
  const takeSubBlocks = (start, collect) => {
    let offset = start;
    const chunks = [];
    for (;;) {
      if (offset >= bytes.length) throw new Error("unterminated GIF data blocks");
      const size = bytes[offset];
      offset += 1;
      if (size === 0) break;
      if (offset + size > bytes.length) throw new Error("truncated GIF data block");
      if (collect) chunks.push(bytes.subarray(offset, offset + size));
      offset += size;
    }
    if (collect && chunks.length > 0) metadata.push(Buffer.concat(chunks));
    return offset;
  };
  try {
    let offset = 13;
    const globalTable = (bytes[10] & 0x80) !== 0
      ? 3 * (2 ** ((bytes[10] & 0x07) + 1))
      : 0;
    offset += globalTable;
    let trailerSeen = false;
    while (offset < bytes.length) {
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0x3b) {
        trailerSeen = true;
        if (offset !== bytes.length) throw new Error("bytes follow the GIF trailer");
        break;
      }
      if (marker === 0x2c) {
        if (offset + 9 > bytes.length) throw new Error("truncated GIF image descriptor");
        const packed = bytes[offset + 8];
        offset += 9;
        if ((packed & 0x80) !== 0) offset += 3 * (2 ** ((packed & 0x07) + 1));
        if (offset >= bytes.length) throw new Error("missing GIF LZW code size");
        offset += 1;
        offset = takeSubBlocks(offset, false);
        continue;
      }
      if (marker !== 0x21 || offset >= bytes.length) throw new Error("unknown GIF block marker");
      const label = bytes[offset];
      offset += 1;
      if (label === 0xf9) {
        if (offset >= bytes.length) throw new Error("truncated GIF graphics control block");
        const size = bytes[offset];
        if (size !== 4) throw new Error("GIF graphics control block size must be 4");
        offset += 1 + size;
        if (offset >= bytes.length || bytes[offset] !== 0) throw new Error("invalid GIF graphics control terminator");
        offset += 1;
        continue;
      }
      if (label === 0x01 || label === 0xff) {
        if (offset >= bytes.length) throw new Error("truncated GIF extension header");
        const headerSize = bytes[offset];
        if ((label === 0x01 && headerSize !== 12) || (label === 0xff && headerSize !== 11)) {
          throw new Error("GIF extension header has an invalid fixed size");
        }
        offset += 1;
        if (offset + headerSize > bytes.length) throw new Error("truncated GIF extension metadata");
        metadata.push(bytes.subarray(offset, offset + headerSize));
        offset += headerSize;
        offset = takeSubBlocks(offset, true);
        continue;
      }
      if (label !== 0xfe) throw new Error(`unknown GIF extension label 0x${label.toString(16)}`);
      offset = takeSubBlocks(offset, true);
    }
    if (!trailerSeen) throw new Error("missing GIF trailer");
  } catch (error) {
    findings.push(makeFinding(
      "invalid-public-asset",
      relativePath,
      1,
      error instanceof Error ? error.message : String(error),
    ));
    return;
  }
  const searchable = Buffer.concat(metadata).toString("latin1");
  for (const pattern of PRIVATE_PATH_PATTERNS) {
    if (pattern.test(searchable)) {
      findings.push(makeFinding("private-path", relativePath, 1, "private path marker embedded in binary asset"));
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(searchable)) {
      findings.push(makeFinding("secret-signature", relativePath, 1, "credential-like literal embedded in binary asset"));
    }
  }
  for (const match of searchable.matchAll(EMAIL_PATTERN)) {
    const email = match[0].toLowerCase();
    if (email.endsWith("@buttereditor.com") || email.endsWith("@example.com")) continue;
    findings.push(makeFinding(
      "customer-email",
      relativePath,
      1,
      "non-product email address embedded in binary asset",
    ));
  }
  for (const marker of HUMAN_MARKERS) {
    if (marker.pattern.test(searchable)) {
      const message = marker.message.replace(/ in public prose or a source comment$/u, "");
      findings.push(makeFinding(marker.code, relativePath, 1, `${message} embedded in binary asset`));
    }
  }
}

function humanSegments(relativePath, content) {
  const extension = extname(relativePath).toLowerCase();
  const lines = content.split("\n");
  if (relativePath === "LICENSE" || extension === ".md" || extension === ".json") {
    return lines.map((text, index) => ({ text, line: index + 1 }));
  }

  const segments = [];
  let inBlock = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    let cursor = 0;
    while (cursor < line.length) {
      if (inBlock) {
        const end = line.indexOf("*/", cursor);
        const stop = end === -1 ? line.length : end + 2;
        segments.push({ text: line.slice(cursor, stop), line: index + 1 });
        if (end === -1) break;
        inBlock = false;
        cursor = stop;
        continue;
      }
      const blockStart = line.indexOf("/*", cursor);
      const slashStart = extension === ".ts" || extension === ".tsx" || extension === ".mjs"
        ? line.indexOf("//", cursor)
        : -1;
      const yamlStart = extension === ".yaml" || extension === ".yml"
        ? line.indexOf("#", cursor)
        : -1;
      const starts = [blockStart, slashStart, yamlStart].filter((value) => value >= 0);
      if (starts.length === 0) break;
      const start = Math.min(...starts);
      if (start === slashStart || start === yamlStart) {
        segments.push({ text: line.slice(start), line: index + 1 });
        break;
      }
      const end = line.indexOf("*/", start + 2);
      if (end === -1) {
        segments.push({ text: line.slice(start), line: index + 1 });
        inBlock = true;
        break;
      }
      segments.push({ text: line.slice(start, end + 2), line: index + 1 });
      cursor = end + 2;
    }
  }
  return segments;
}

export function maskVerifierRuleDefinitions(relativePath, content) {
  if (!SELF_RULE_DEFINITION_PATHS.has(relativePath)) return content;
  const startMarker = "// verifier-rule-definitions:start";
  const endMarker = "// verifier-rule-definitions:end";
  const start = content.indexOf(startMarker);
  const endMarkerStart = content.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || endMarkerStart < 0) return content;
  const end = endMarkerStart + endMarker.length;
  const masked = content.slice(start, end).replace(/[^\n]/gu, " ");
  return `${content.slice(0, start)}${masked}${content.slice(end)}`;
}

function scanText(relativePath, content, findings) {
  const authoredContent = maskVerifierRuleDefinitions(relativePath, content);
  const searchableContent = relativePath === "main.js"
    ? authoredContent.replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/gu, "")
    : authoredContent;
  for (const issue of publicTextHygieneFindings(authoredContent)) {
    findings.push(makeFinding(
      issue.code,
      relativePath,
      lineAt(content, issue.index),
      issue.message,
    ));
  }
  for (const pattern of PRIVATE_PATH_PATTERNS) {
    const match = pattern.exec(searchableContent);
    if (match) {
      findings.push(makeFinding(
        "private-path",
        relativePath,
        lineAt(content, match.index),
        "private workspace or repository path in public text",
      ));
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.exec(searchableContent);
    if (match) {
      findings.push(makeFinding(
        "secret-signature",
        relativePath,
        lineAt(content, match.index),
        "credential-like literal in public text",
      ));
    }
  }
  for (const match of searchableContent.matchAll(EMAIL_PATTERN)) {
    const email = match[0].toLowerCase();
    if (email.endsWith("@buttereditor.com") || email.endsWith("@example.com")) continue;
    findings.push(makeFinding(
      "customer-email",
      relativePath,
      lineAt(searchableContent, match.index),
      "non-product email address in public text",
    ));
  }

  if (relativePath !== "main.js") {
    for (const segment of humanSegments(relativePath, authoredContent)) {
      for (const marker of HUMAN_MARKERS) {
        if (marker.pattern.test(segment.text)) {
          findings.push(makeFinding(
            marker.code,
            relativePath,
            segment.line,
            marker.message,
          ));
        }
      }
    }
  }

  if (/\.(?:mjs|tsx?)$/u.test(relativePath)) {
    for (const hook of DEV_HOOK_PATTERNS) {
      const match = hook.pattern.exec(authoredContent);
      if (match) {
        findings.push(makeFinding(
          "production-dev-hook",
          relativePath,
          lineAt(content, match.index),
          hook.message,
        ));
      }
    }
  }
  if (relativePath === "main.js") {
    for (const pattern of BUNDLE_BYPASS_PATTERNS) {
      const match = pattern.exec(searchableContent);
      if (match) {
        findings.push(makeFinding(
          "production-dev-hook",
          relativePath,
          lineAt(content, match.index),
          "license bypass or development hook in the production bundle",
        ));
      }
    }
  }
}

function inspectAuthoredRuntimeStrings(files, textByFile, typescript, findings) {
  if (!typescript) return;
  const ts = typescript;
  for (const relativePath of files.filter((file) => /\.(?:tsx?|mjs)$/u.test(file))) {
    const originalContent = textByFile.get(relativePath);
    if (originalContent === undefined) continue;
    const content = maskVerifierRuleDefinitions(relativePath, originalContent);
    const scriptKind = relativePath.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : relativePath.endsWith(".mjs")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(
      relativePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );
    const visit = (node) => {
      let value = "";
      if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) {
        value = node.text;
      } else if (
        node.kind === ts.SyntaxKind.TemplateHead
        || node.kind === ts.SyntaxKind.TemplateMiddle
        || node.kind === ts.SyntaxKind.TemplateTail
      ) {
        value = node.text ?? "";
      }
      if (value) {
        for (const marker of HUMAN_MARKERS) {
          if (!marker.pattern.test(value)) continue;
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const message = marker.message.replace(/ in public prose or a source comment$/u, "");
          findings.push(makeFinding(
            marker.code,
            relativePath,
            position.line + 1,
            `${message} in authored runtime string`,
          ));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

function parseJson(relativePath, findings, textByFile) {
  if (!textByFile.has(relativePath)) return null;
  try {
    return JSON.parse(textByFile.get(relativePath));
  } catch (error) {
    findings.push(makeFinding(
      "invalid-json",
      relativePath,
      1,
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return null;
  }
}

function dependencyRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, specifier]) => typeof specifier === "string")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function sameRecord(left, right) {
  return JSON.stringify(dependencyRecord(left)) === JSON.stringify(dependencyRecord(right));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJson(entry)]),
  );
}

function inspectTsconfig(tsconfig, findings) {
  if (
    !tsconfig
    || typeof tsconfig !== "object"
    || JSON.stringify(canonicalJson(tsconfig)) !== JSON.stringify(canonicalJson(PUBLIC_TSCONFIG))
  ) {
    findings.push(makeFinding(
      "unsafe-tsconfig",
      "tsconfig.json",
      1,
      "public tsconfig must match the fixed non-resolving schema exactly",
    ));
  }
}

function inspectPackageMetadata(packageJson, packageLock, version, findings) {
  if (!packageJson || typeof packageJson !== "object") return;
  for (const message of publicPackageMetadataErrors(packageJson, version)) {
    findings.push(makeFinding("package-metadata", "package.json", 1, message));
  }
  if (JSON.stringify(Object.keys(packageJson).sort()) !== JSON.stringify(PUBLIC_PACKAGE_KEYS)) {
    findings.push(makeFinding(
      "package-metadata",
      "package.json",
      1,
      "public package fields must match the fixed allowlist exactly",
    ));
  }
  if (packageJson.name !== "butter-editor") {
    findings.push(makeFinding(
      "package-metadata",
      "package.json",
      1,
      "public package name must be exactly butter-editor",
    ));
  }
  if (
    packageJson.main !== "main.js"
    || packageJson.license !== "UNLICENSED"
    || typeof packageJson.description !== "string"
    || packageJson.description.trim() === ""
  ) {
    findings.push(makeFinding(
      "package-metadata",
      "package.json",
      1,
      "public package main, license, and description metadata are invalid",
    ));
  }
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name, specifier] of Object.entries(dependencyRecord(packageJson[field]))) {
      if (!/^(?:(?:\^|~)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|latest)$/u.test(specifier)) {
        findings.push(makeFinding(
          "unsafe-package-specifier",
          "package.json",
          1,
          `${field}.${name} must be a plain registry semver range (npm aliases, URLs, Git, files, and workspaces are forbidden)`,
        ));
      }
    }
  }
  const scripts = packageJson.scripts && typeof packageJson.scripts === "object"
    && !Array.isArray(packageJson.scripts)
    ? packageJson.scripts
    : {};
  if (scripts.build !== PUBLIC_BUILD_SCRIPT) {
    findings.push(makeFinding(
      "package-script",
      "package.json",
      1,
      `build script must be exactly ${JSON.stringify(PUBLIC_BUILD_SCRIPT)}`,
    ));
  }
  for (const name of Object.keys(scripts)) {
    if (name === "build") continue;
    const lifecycle = /^(?:pre|post)?(?:install|pack|prepare|publish|version)$/u.test(name)
      || name === "prepublishOnly";
    findings.push(makeFinding(
      "package-script",
      "package.json",
      1,
      lifecycle
        ? `install/publish lifecycle script is not allowed: ${name}`
        : `unexpected public package script: ${name}`,
    ));
  }

  if (!packageLock || typeof packageLock !== "object") return;
  if (packageLock.lockfileVersion !== 3) {
    findings.push(makeFinding(
      "package-lock-mismatch",
      "package-lock.json",
      1,
      "public package-lock must use lockfileVersion 3",
    ));
  }
  const lockRoot = packageLock.packages && typeof packageLock.packages === "object"
    ? packageLock.packages[""]
    : null;
  if (!lockRoot || typeof lockRoot !== "object") {
    findings.push(makeFinding(
      "package-lock-mismatch",
      "package-lock.json",
      1,
      "package-lock is missing packages[\"\"] root metadata",
    ));
    return;
  }
  if (
    JSON.stringify(Object.keys(packageLock).sort())
      !== JSON.stringify(["lockfileVersion", "name", "packages", "requires", "version"])
    || JSON.stringify(Object.keys(lockRoot).sort())
      !== JSON.stringify(["dependencies", "devDependencies", "license", "name", "version"])
  ) {
    findings.push(makeFinding(
      "package-lock-mismatch",
      "package-lock.json",
      1,
      "public package-lock root fields must match the fixed allowlist exactly",
    ));
  }
  const expectedName = packageJson.name;
  for (const [label, actual] of [
    ["top-level name", packageLock.name],
    ["root package name", lockRoot.name],
  ]) {
    if (actual !== expectedName) {
      findings.push(makeFinding(
        "package-lock-mismatch",
        "package-lock.json",
        1,
        `${label} does not match package.json`,
      ));
    }
  }
  for (const [label, actual] of [
    ["top-level version", packageLock.version],
    ["root package version", lockRoot.version],
  ]) {
    if (actual !== version) {
      findings.push(makeFinding(
        "package-lock-mismatch",
        "package-lock.json",
        1,
        `${label} does not match --version`,
      ));
    }
  }
  for (const field of ["dependencies", "devDependencies"]) {
    if (!sameRecord(packageJson[field], lockRoot[field])) {
      findings.push(makeFinding(
        "package-lock-mismatch",
        "package-lock.json",
        1,
        `root ${field} do not match package.json`,
      ));
    }
  }
  for (const [path, entry] of Object.entries(packageLock.packages ?? {})) {
    if (!path || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (
      typeof entry.resolved !== "string"
      || !entry.resolved.startsWith("https://registry.npmjs.org/")
      || typeof entry.integrity !== "string"
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity)
      || entry.link === true
    ) {
      findings.push(makeFinding(
        "unsafe-lock-resolution",
        "package-lock.json",
        1,
        `${path} is not pinned to an integrity-protected npm registry artifact`,
      ));
    }
  }
}

function inspectLocalControlManifest(manifest, findings) {
  const controls = manifest?.controls;
  if (
    manifest?.version !== 1
    || JSON.stringify(Object.keys(manifest ?? {}).sort()) !== JSON.stringify(["controls", "version"])
    || !controls
    || typeof controls !== "object"
    || Array.isArray(controls)
    || JSON.stringify(Object.keys(controls).sort()) !== JSON.stringify(LOCAL_CONTROL_KEYS)
  ) {
    findings.push(makeFinding(
      "control-manifest",
      ".github/release-control-hashes.json",
      1,
      "local-control manifest schema or keyset is invalid",
    ));
    return;
  }
  for (const [name, hash] of Object.entries(controls)) {
    if (!/^[0-9a-f]{64}$/u.test(hash) || /^0{64}$/u.test(hash)) {
      findings.push(makeFinding(
        "control-manifest",
        ".github/release-control-hashes.json",
        1,
        `${name} is not a nonzero lowercase SHA-256`,
      ));
    }
  }
}

function compareCanonicalVersions(left, right) {
  const leftParts = left.split(".").map(BigInt);
  const rightParts = right.split(".").map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

function inspectManifestMetadata(manifest, version, findings) {
  const expectedKeys = [
    "author",
    "authorUrl",
    "description",
    "id",
    "isDesktopOnly",
    "minAppVersion",
    "name",
    "version",
  ];
  if (
    !manifest
    || typeof manifest !== "object"
    || Array.isArray(manifest)
    || JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(expectedKeys)
  ) {
    findings.push(makeFinding(
      "manifest-metadata",
      "manifest.json",
      1,
      "manifest fields must match the fixed public product schema exactly",
    ));
    return;
  }
  if (
    manifest.id !== "butter-editor"
    || manifest.name !== "Butter Editor"
    || manifest.author !== "Spreadwell"
    || manifest.authorUrl !== "https://github.com/spreadwell"
    || manifest.isDesktopOnly !== false
    || manifest.version !== version
    || !PUBLIC_VERSION_RE.test(manifest.minAppVersion ?? "")
    || typeof manifest.description !== "string"
    || manifest.description.trim() !== manifest.description
    || manifest.description.length < 10
    || /[\r\n]/u.test(manifest.description)
  ) {
    findings.push(makeFinding(
      "manifest-metadata",
      "manifest.json",
      1,
      "manifest product identity, version, compatibility, or description is invalid",
    ));
  }
}

function inspectVersionsMetadata(versions, content, version, minAppVersion, findings) {
  if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
    findings.push(makeFinding("versions-metadata", "versions.json", 1, "versions.json must contain one version map object"));
    return;
  }
  const keys = Object.keys(versions);
  const rawKeys = [...content.matchAll(/^\s*"([^"]+)"\s*:/gmu)].map((match) => match[1]);
  if (
    keys.length === 0
    || rawKeys.length !== keys.length
    || new Set(rawKeys).size !== rawKeys.length
    || JSON.stringify(rawKeys) !== JSON.stringify(keys)
    || keys.some((key) => !PUBLIC_VERSION_RE.test(key))
    || Object.values(versions).some((value) => typeof value !== "string" || !PUBLIC_VERSION_RE.test(value))
    || JSON.stringify(keys) !== JSON.stringify([...keys].sort(compareCanonicalVersions))
    || keys.at(-1) !== version
    || versions[version] !== minAppVersion
  ) {
    findings.push(makeFinding(
      "versions-metadata",
      "versions.json",
      1,
      "versions.json must be a duplicate-free, strictly ordered canonical semver map ending in the current manifest mapping",
    ));
  }
}

function inspectReleaseNotes(files, version, findings, textByFile) {
  const currentNote = `release-notes/${version}.md`;
  if (!files.includes(currentNote)) {
    findings.push(makeFinding(
      "missing-release-note",
      currentNote,
      1,
      "current customer-facing release note is missing",
    ));
  }
  for (const relativePath of files.filter((file) => file.startsWith("release-notes/"))) {
    const content = textByFile.get(relativePath);
    if (content === undefined) continue;
    const withoutComments = content.replace(/<!--[\s\S]*?-->/gu, "").trim();
    const body = withoutComments
      .split("\n")
      .filter((line) => !/^\s*#{1,6}\s+/u.test(line))
      .join("\n")
      .trim();
    if (!body) {
      findings.push(makeFinding(
        "release-note-placeholder",
        relativePath,
        1,
        "release note has no customer-facing content",
      ));
    }
  }
}

function markdownTargets(content) {
  const targets = [];
  const patterns = [
    /!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/gmu,
    /^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gmu,
    /\b(?:href|src)\s*=\s*["']([^"']+)["']/gimu,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      targets.push({ target: match[1], index: match.index });
    }
  }
  return targets;
}

function localMarkdownPath(markdownFile, rawTarget) {
  let target = rawTarget.trim();
  if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
  if (!target || target.startsWith("#") || target.startsWith("//")) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)) return null;
  target = target.split("#", 1)[0].split("?", 1)[0];
  try {
    target = decodeURIComponent(target);
  } catch {
    return "";
  }
  if (!target) return null;
  const relative = target.startsWith("/")
    ? target.slice(1)
    : posix.join(posix.dirname(markdownFile), target);
  const normalized = posix.normalize(relative);
  if (normalized === ".." || normalized.startsWith("../")) return "";
  return normalized;
}

function inspectMarkdownLinks(root, files, findings, textByFile) {
  for (const relativePath of files.filter((file) => file.endsWith(".md"))) {
    const content = textByFile.get(relativePath);
    if (content === undefined) continue;
    for (const { target, index } of markdownTargets(content)) {
      const localPath = localMarkdownPath(relativePath, target);
      if (localPath === null) continue;
      if (!localPath || !existsSync(join(root, ...localPath.split("/")))) {
        findings.push(makeFinding(
          "missing-markdown-link",
          relativePath,
          lineAt(content, index),
          `local Markdown target does not exist: ${target}`,
        ));
      }
    }
  }
}

export function stripJavaScriptComments(content) {
  let output = "";
  let state = "code";
  let quote = "";
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    const next = content[index + 1] ?? "";
    if (state === "line-comment") {
      if (char === "\n" || char === "\r") {
        output += char;
        state = "code";
      } else {
        output += " ";
      }
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        output += "  ";
        index++;
        state = "code";
      } else {
        output += char === "\n" || char === "\r" ? char : " ";
      }
      continue;
    }
    if (state === "string") {
      output += char;
      if (char === "\\") {
        if (next) {
          output += next;
          index++;
        }
      } else if (char === quote) {
        state = "code";
        quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      output += char;
      state = "string";
      quote = char;
    } else if (char === "/" && next === "/") {
      output += "  ";
      index++;
      state = "line-comment";
    } else if (char === "/" && next === "*") {
      output += "  ";
      index++;
      state = "block-comment";
    } else {
      output += char;
    }
  }
  return output;
}

function loadTypeScript(dependencyRoot, findings) {
  try {
    return createRequire(join(resolve(dependencyRoot), "package.json"))("typescript");
  } catch (error) {
    findings.push(makeFinding(
      "missing-typescript-parser",
      "package.json",
      1,
      `trusted TypeScript parser is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    ));
    return null;
  }
}

export function extractModuleEdges(content, typescript, fileName = "source.ts") {
  const ts = typescript;
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const edges = [];
  const add = (specifier, typeOnly, kind, node) => {
    edges.push({
      column: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).character + 1,
      kind,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      specifier,
      typeOnly,
    });
  };
  const stringValue = (node) => ts.isStringLiteralLike(node) ? node.text : "";

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringValue(node.moduleSpecifier);
      const clause = node.importClause;
      let typeOnly = Boolean(clause?.isTypeOnly);
      if (
        clause
        && !clause.name
        && clause.namedBindings
        && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0
        && clause.namedBindings.elements.every((element) => element.isTypeOnly)
      ) typeOnly = true;
      add(specifier, typeOnly, "import", node);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      let typeOnly = Boolean(node.isTypeOnly);
      if (
        node.exportClause
        && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.length > 0
        && node.exportClause.elements.every((element) => element.isTypeOnly)
      ) typeOnly = true;
      add(stringValue(node.moduleSpecifier), typeOnly, "export", node);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(stringValue(node.moduleReference.expression), Boolean(node.isTypeOnly), "import-equals", node);
    } else if (ts.isImportTypeNode(node)) {
      const literal = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : null;
      add(literal ? stringValue(literal) : "", true, "import-type", node);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        add(node.arguments.length === 1 ? stringValue(node.arguments[0]) : "", false, isDynamicImport ? "dynamic-import" : "require", node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { diagnostics: sourceFile.parseDiagnostics ?? [], edges, sourceFile };
}

export function extractModuleSpecifiers(content, typescript, fileName = "source.ts") {
  return [...new Set(
    extractModuleEdges(content, typescript, fileName).edges
      .map((edge) => edge.specifier)
      .filter(Boolean),
  )];
}

function resolveSourceImport(fromFile, specifier, sourceSet) {
  if (!specifier.startsWith(".")) return null;
  let base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  const candidates = [];
  if (/\.(?:tsx?|js|jsx)$/u.test(base)) {
    candidates.push(base, base.replace(/\.(?:js|jsx)$/u, ".ts"), base.replace(/\.(?:js|jsx)$/u, ".tsx"));
  } else {
    candidates.push(
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.d.ts`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
      `${base}/index.d.ts`,
    );
  }
  return candidates.find((candidate) => sourceSet.has(candidate)) ?? "";
}

function dependencyName(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) {
    return null;
  }
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

export function isSafeSourceSpecifier(specifier) {
  if (typeof specifier !== "string" || specifier === "") return false;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return !specifier.includes("\\") && !/[\u0000-\u001f\u007f?#]/u.test(specifier);
  }
  return NODE_BUILTINS.has(specifier) || BARE_SOURCE_SPECIFIER.test(specifier);
}

function hasRuntimeEmission(content, typescript, fileName) {
  const output = typescript.transpileModule(content, {
    compilerOptions: {
      module: typescript.ModuleKind.ESNext,
      removeComments: true,
      target: typescript.ScriptTarget.ESNext,
      verbatimModuleSyntax: true,
    },
    fileName,
    reportDiagnostics: false,
  }).outputText;
  return output.replace(/^\s*export\s*\{\s*\};?\s*$/gmu, "").trim().length > 0;
}

function inspectReachability(files, packageJson, findings, textByFile, typescript) {
  const sourceFiles = files.filter((file) => /\.tsx?$/u.test(file));
  const sourceSet = new Set(sourceFiles);
  if (!sourceSet.has("src/main.ts") || !typescript) return;

  const edgesByFile = new Map();
  for (const file of sourceFiles) {
    const parsed = extractModuleEdges(textByFile.get(file) ?? "", typescript, file);
    edgesByFile.set(file, parsed.edges);
    for (const diagnostic of parsed.diagnostics) {
      const position = diagnostic.start ?? 0;
      findings.push(makeFinding(
        "typescript-parse-error",
        file,
        parsed.sourceFile.getLineAndCharacterOfPosition(position).line + 1,
        typescript.flattenDiagnosticMessageText(diagnostic.messageText, " "),
      ));
    }
    for (const edge of parsed.edges) {
      if (!edge.specifier) {
        findings.push(makeFinding(
          "nonliteral-source-import",
          file,
          edge.line,
          `${edge.kind} must use one static string specifier`,
        ));
      } else if (!isSafeSourceSpecifier(edge.specifier)) {
        findings.push(makeFinding(
          "unsafe-source-import",
          file,
          edge.line,
          `${edge.kind} must use an explicit relative path, audited bare package specifier, or Node builtin`,
        ));
      }
    }
  }

  const runtimeReachable = new Set();
  const queue = ["src/main.ts"];
  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || runtimeReachable.has(file)) continue;
    runtimeReachable.add(file);
    for (const edge of edgesByFile.get(file) ?? []) {
      if (edge.typeOnly || !edge.specifier) continue;
      const resolvedImport = resolveSourceImport(file, edge.specifier, sourceSet);
      if (resolvedImport === "") {
        findings.push(makeFinding(
          "unresolved-source-import",
          file,
          edge.line,
          `relative runtime import cannot be resolved: ${edge.specifier}`,
        ));
      } else if (resolvedImport && !runtimeReachable.has(resolvedImport)) {
        queue.push(resolvedImport);
      }
    }
  }

  const typeNeeded = new Set(runtimeReachable);
  const typeQueue = [...runtimeReachable];
  while (typeQueue.length > 0) {
    const file = typeQueue.shift();
    for (const edge of edgesByFile.get(file) ?? []) {
      if (!edge.specifier || !isSafeSourceSpecifier(edge.specifier)) continue;
      const resolvedImport = resolveSourceImport(file, edge.specifier, sourceSet);
      if (resolvedImport === "") {
        findings.push(makeFinding(
          "unresolved-source-import",
          file,
          edge.line,
          `relative import cannot be resolved: ${edge.specifier}`,
        ));
      } else if (resolvedImport && !typeNeeded.has(resolvedImport)) {
        typeNeeded.add(resolvedImport);
        typeQueue.push(resolvedImport);
      }
    }
  }
  const isRequiredAmbientDeclaration = (file) => /\bdeclare\s+(?:global|module\s+["'][^"']+["'])/u
    .test(textByFile.get(file) ?? "");
  for (const file of sourceFiles.filter((path) => /\.d\.ts$/u.test(path) && !typeNeeded.has(path))) {
    if (isRequiredAmbientDeclaration(file)) continue;
    findings.push(makeFinding(
      "unreachable-declaration",
      file,
      1,
      "declaration file is not required by reachable source",
    ));
  }
  const authoredSources = sourceFiles.filter((file) => !/\.d\.ts$/u.test(file));
  for (const file of authoredSources) {
    if (runtimeReachable.has(file)) continue;
    const isRequiredTypeSurface = typeNeeded.has(file)
      && !hasRuntimeEmission(textByFile.get(file) ?? "", typescript, file);
    if (isRequiredTypeSurface) continue;
    findings.push(makeFinding(
      "unreachable-source",
      file,
      1,
      typeNeeded.has(file)
        ? "type-reachable TypeScript emits runtime code but is absent from the runtime graph"
        : "authored TypeScript is not reachable from src/main.ts",
    ));
  }

  const dependencies = packageJson?.dependencies && typeof packageJson.dependencies === "object"
    ? new Set(Object.keys(packageJson.dependencies))
    : new Set();
  const devDependencies = packageJson?.devDependencies && typeof packageJson.devDependencies === "object"
    ? new Set(Object.keys(packageJson.devDependencies))
    : new Set();
  const declared = new Set([...dependencies, ...devDependencies]);
  const usage = new Map();
  for (const file of sourceFiles) {
    for (const edge of edgesByFile.get(file) ?? []) {
      if (!edge.specifier) continue;
      const name = dependencyName(edge.specifier);
      if (name && !declared.has(name) && !NODE_BUILTINS.has(edge.specifier)) {
        findings.push(makeFinding(
          "undeclared-source-dependency",
          file,
          edge.line,
          `${edge.specifier} is not declared in public package metadata`,
        ));
      }
      if (!name || !dependencies.has(name) || edge.typeOnly) continue;
      const record = usage.get(name) ?? { reachable: new Set(), unreachable: new Set() };
      if (runtimeReachable.has(file)) record.reachable.add(file);
      else record.unreachable.add(file);
      usage.set(name, record);
    }
  }
  for (const name of dependencies) {
    const record = usage.get(name) ?? { reachable: new Set(), unreachable: new Set() };
    if (record.reachable.size > 0) continue;
    if (record.unreachable.size > 0) {
      findings.push(makeFinding(
        "dependency-only-unreachable",
        "package.json",
        1,
        `${name} is referenced only by unreachable source: ${[...record.unreachable].join(", ")}`,
      ));
    } else {
      findings.push(makeFinding(
        "unused-production-dependency",
        "package.json",
        1,
        `${name} has no reachable import from src/main.ts`,
      ));
    }
  }
  for (const name of devDependencies) {
    if (!PUBLIC_DEV_DEPENDENCIES.has(name)) {
      findings.push(makeFinding(
        "unnecessary-public-dev-dependency",
        "package.json",
        1,
        `${name} is not required by the public build or type-review surface`,
      ));
    }
  }
  for (const required of ["esbuild", "typescript"]) {
    if (!devDependencies.has(required)) {
      findings.push(makeFinding(
        "missing-public-dev-dependency",
        "package.json",
        1,
        `${required} is required by the public build/review gate`,
      ));
    }
  }
}

function deduplicateFindings(findings) {
  const seen = new Set();
  return findings
    .filter((finding) => {
      const key = `${finding.code}\0${finding.file}\0${finding.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.file.localeCompare(right.file)
      || left.line - right.line
      || left.code.localeCompare(right.code));
}

export function verifyPublicSurface({ dependencyRoot = root, root, version }) {
  const absoluteRoot = resolve(root);
  const findings = [];
  if (!existsSync(absoluteRoot) || !lstatSync(absoluteRoot).isDirectory()) {
    return [makeFinding("invalid-root", slash(absoluteRoot), 1, "public root is not a directory")];
  }
  if (!PUBLIC_VERSION_RE.test(version)) {
    return [makeFinding("invalid-version", "<cli>", 1, "version must be canonical bare semver")];
  }

  const files = inspectTree(absoluteRoot, findings);
  for (const requiredPath of [...REQUIRED_PATHS, `release-notes/${version}.md`]) {
    if (!files.includes(requiredPath)) {
      findings.push(makeFinding(
        "missing-public-file",
        requiredPath,
        1,
        "required public file is missing",
      ));
    }
  }

  const textByFile = new Map();
  for (const relativePath of files) {
    scanPublicPath(relativePath, findings);
    if (PUBLIC_ASSET_PATHS.has(relativePath)) {
      inspectBinaryAsset(absoluteRoot, relativePath, findings);
      continue;
    }
    if (
      relativePath !== "LICENSE"
      && !TEXT_EXTENSIONS.has(extname(relativePath).toLowerCase())
    ) continue;
    let content;
    try {
      content = readPublicFile(absoluteRoot, relativePath);
      textByFile.set(relativePath, content);
    } catch (error) {
      findings.push(makeFinding(
        "invalid-text-encoding",
        relativePath,
        1,
        error instanceof Error ? error.message : String(error),
      ));
      continue;
    }
    scanText(
      relativePath,
      content,
      findings,
    );
  }

  const manifest = parseJson("manifest.json", findings, textByFile);
  const localControlManifest = parseJson(".github/release-control-hashes.json", findings, textByFile);
  const packageJson = parseJson("package.json", findings, textByFile);
  const versions = parseJson("versions.json", findings, textByFile);
  const packageLock = parseJson("package-lock.json", findings, textByFile);
  const tsconfig = parseJson("tsconfig.json", findings, textByFile);

  inspectManifestMetadata(manifest, version, findings);
  inspectVersionsMetadata(
    versions,
    textByFile.get("versions.json") ?? "",
    version,
    manifest?.minAppVersion,
    findings,
  );
  if (manifest && manifest.version !== version) {
    findings.push(makeFinding("version-mismatch", "manifest.json", 1, "manifest version does not match --version"));
  }
  if (packageJson && packageJson.version !== version) {
    findings.push(makeFinding("version-mismatch", "package.json", 1, "package version does not match --version"));
  }
  if (versions && versions[version] !== manifest?.minAppVersion) {
    findings.push(makeFinding("version-mismatch", "versions.json", 1, "current version/minAppVersion mapping is missing or inconsistent"));
  }

  inspectPackageMetadata(packageJson, packageLock, version, findings);
  inspectTsconfig(tsconfig, findings);
  inspectLocalControlManifest(localControlManifest, findings);
  inspectReleaseNotes(files, version, findings, textByFile);
  inspectMarkdownLinks(absoluteRoot, files, findings, textByFile);
  const typescript = loadTypeScript(dependencyRoot, findings);
  inspectAuthoredRuntimeStrings(files, textByFile, typescript, findings);
  inspectReachability(files, packageJson, findings, textByFile, typescript);
  return deduplicateFindings(findings);
}

export function formatFindings(findings, limit = 100) {
  const visible = findings.slice(0, limit).map((finding) => {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    return `[${finding.code}] ${location} ${finding.message}`;
  });
  if (findings.length > limit) visible.push(`... ${findings.length - limit} more findings`);
  return visible.join("\n");
}

export function parseCliArgs(argv) {
  const result = { dependencyRoot: "", gitCommit: "", gitRoot: "", root: "", version: "" };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--root") result.root = argv[++index] ?? "";
    else if (argument.startsWith("--root=")) result.root = argument.slice("--root=".length);
    else if (argument === "--dependency-root") result.dependencyRoot = argv[++index] ?? "";
    else if (argument.startsWith("--dependency-root=")) result.dependencyRoot = argument.slice("--dependency-root=".length);
    else if (argument === "--version") result.version = argv[++index] ?? "";
    else if (argument.startsWith("--version=")) result.version = argument.slice("--version=".length);
    else if (argument === "--git-root") result.gitRoot = argv[++index] ?? "";
    else if (argument.startsWith("--git-root=")) result.gitRoot = argument.slice("--git-root=".length);
    else if (argument === "--git-commit") result.gitCommit = argv[++index] ?? "";
    else if (argument.startsWith("--git-commit=")) result.gitCommit = argument.slice("--git-commit=".length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!result.root || !result.version || Boolean(result.gitRoot) !== Boolean(result.gitCommit)) {
    throw new Error("Usage: verify-public-surface.mjs --root <public-root> --version <x.y.z> [--dependency-root <installed-package-root>] [--git-root <repo-root> --git-commit <40-char-sha>]");
  }
  if (!result.dependencyRoot) result.dependencyRoot = result.root;
  return result;
}

export function runCli(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const findings = verifyPublicSurface(options);
  if (options.gitRoot) {
    const gitFindings = verifyGitTree({
      commit: options.gitCommit,
      repoRoot: options.gitRoot,
      root: options.root,
    });
    findings.push(...gitFindings);
    if (gitFindings.length === 0) {
      try {
        validatePublishedVersionHistory({
          auditParent: dirname(resolve(options.root)),
          excludedTag: options.version,
          versionsRef: options.gitCommit,
          versionsRepo: options.gitRoot,
        });
      } catch (error) {
        findings.push(makeFinding(
          "published-version-history",
          "versions.json",
          1,
          error instanceof Error ? error.message : String(error),
        ));
      }
    }
  }
  if (findings.length > 0) {
    console.error(`Public surface verification failed (${findings.length} findings)`);
    console.error(formatFindings(findings));
    return 1;
  }
  console.log(`Public surface verification passed for ${options.version}`);
  return 0;
}

const directInvocation = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (directInvocation) process.exitCode = runCli();
