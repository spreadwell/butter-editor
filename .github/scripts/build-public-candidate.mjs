#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED_NODE_VERSION = "v24.13.0";
const CANONICAL_PUBLIC_REMOTE = "https://github.com/spreadwell/butter-editor.git";
const SHA_1 = /^[0-9a-f]{40}$/u;
const SHA_256 = /^[0-9a-f]{64}$/u;
const NODE_INJECTION_ENVIRONMENT = /^(?:NODE_|NODE_OPTIONS$|NODE_PATH$)/iu;
const GIT_OBJECT_OVERLAY_ENVIRONMENT = /^(?:GIT_(?:ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|CONFIG_(?:COUNT|KEY_\d+|PARAMETERS|VALUE_\d+)|DIR|GRAFT_FILE|INDEX_FILE|OBJECT_DIRECTORY|REPLACE_REF_BASE|SHALLOW_FILE|WORK_TREE))$/iu;
const DANGEROUS_LOCAL_GIT_CONFIG = /^(?:include(?:if)?\.|url\.|http\.|credential\.|protocol\.|submodule\.|filter\.|gpg\.|commit\.gpgsign$|tag\.gpgsign$|user\.signingkey$|extensions\.worktreeconfig$|core\.(?:alternaterefscommand|alternaterefsprefixes|askpass|attributesfile|gitproxy|hookspath|sshcommand|worktree)|diff\..*\.command|merge\..*\.driver|remote\.[^.]+\.(?:partialclonefilter|promisor|proxy|receivepack|uploadpack|vcs))/iu;
const ISO_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const GITHUB_RUN_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/u;
const PUBLIC_VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const CANONICAL_LOCAL_CONTROL_REMOTE_SHA256 = "64b7d54bea8e52776549d1d2ef96bb48eec47f15d9b1d05774572ca85a0aba73";
const RELEASE_ENVIRONMENT_REVIEWER_ID = 57109738;
export const RELEASE_AUTHORIZATION_TTL_MS = 15 * 60 * 1000;
const PINNED_NODE_EXE_SHA256 = "d14ba95cdce1ef7dc9ad3ac74949ca5db38b27378ee30f30a23cf26f9e875a11";
const PINNED_WDM_DEPENDENCIES = Object.freeze({
  gh: Object.freeze({
    command: "bin/gh.exe",
    directoryCount: 1,
    fileCount: 1,
    manifestSha256: "860c4a183bf10b04545dca3910303180a0109c298be273400716b560de66b38f",
    treeSha256: "06b5a101394896a0e619960a7c2d62a7715a2945d5ae5de13f89ea52d4bbe79e",
    version: "2.74.0",
  }),
  git: Object.freeze({
    command: "cmd/git.exe",
    directoryCount: 70,
    fileCount: 365,
    manifestSha256: "c5589d7ed59c704814b47fc1e7fe04b6f8a26f5f6caed330388c2b8042f614b8",
    treeSha256: "4fe6a9f91d30e406c4ce174bb3d7cf2965a8de2044cb740692d977a5b3587fe9",
    version: "2.55.0.windows.3",
  }),
  npm: Object.freeze({
    command: "../../runtime/node/node.exe",
    directoryCount: 539,
    fileCount: 2109,
    manifestSha256: "3f0e9a9bcd0021641e6d9280124c301edcc7dab742ef275b07ca941cf01ff71f",
    treeSha256: "1b5a9bfdf52c43faf368aa16318bdd15a641b88bc33637ccbec1a093bb63065d",
    version: "11.6.2",
  }),
});
export const RELEASE_AUTHORIZATION_DOMAIN = "BTR_PUBLIC_RELEASE_AUTHORIZATION_V1\0spreadwell/butter-editor\0.github/workflows/release.yml\0";
export const RELEASE_AUTHORIZATION_KEYRING = Object.freeze({
  c89c52836c20c650df594ebfa256ea117c44ad05616e3681790e33b5ac7b7489:
    "MCowBQYDK2VwAyEAfqlsfmyaa3g18MMOUyaV1YQC4nQuAoOC4Es/OcLJCMo=",
});
export const ACTIVE_RELEASE_AUTHORIZATION_KEY_ID = "c89c52836c20c650df594ebfa256ea117c44ad05616e3681790e33b5ac7b7489";
const PUBLIC_SCRIPT_PATHS = new Map([
  ["scripts/build-public-candidate.mjs", ".github/scripts/build-public-candidate.mjs"],
  ["scripts/public-export-shape.mjs", ".github/scripts/public-export-shape.mjs"],
  ["scripts/public-version-history.mjs", ".github/scripts/public-version-history.mjs"],
  ["scripts/verify-public-surface.mjs", ".github/scripts/verify-public-surface.mjs"],
]);
const LOCAL_CONTROL_PATHS = new Map([
  ["candidateVerifier", "scripts/verify-public-candidate.mjs"],
  ["publicExporter", "scripts/export-public-source.mjs"],
  ["reviewPush", "scripts/push-public-review.mjs"],
]);
const CONTROL_TARGETS = new Map([
  ["candidateVerifier", "scripts/verify-public-candidate.mjs"],
  ["publicExporter", "scripts/export-public-source.mjs"],
  ["reviewPush", "scripts/push-public-review.mjs"],
]);

function slash(path) {
  return path.replace(/\\/gu, "/");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function errorText(error) {
  if (!(error instanceof Error)) return String(error);
  const stderr = "stderr" in error && error.stderr ? String(error.stderr).trim() : "";
  return stderr || error.message;
}

export function canonicalReleaseJson(value) {
  if (Array.isArray(value)) return value.map(canonicalReleaseJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalReleaseJson(value[key])]),
    );
  }
  return value;
}

export function canonicalReleaseEvidenceBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalReleaseJson(value), null, 2)}\n`, "utf8");
}

function exactKeys(value, keys) {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function comparePublicVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function isCanonicalPublishedHistory(value) {
  return exactKeys(value, ["lastTag", "snapshotSha256", "tagCount", "tags"])
    && Number.isInteger(value.tagCount)
    && value.tagCount > 0
    && Array.isArray(value.tags)
    && value.tags.length === value.tagCount
    && value.tags.every((tag) => PUBLIC_VERSION_RE.test(tag))
    && value.tags.every((tag, index) => index === 0 || comparePublicVersions(value.tags[index - 1], tag) < 0)
    && value.lastTag === value.tags.at(-1)
    && SHA_256.test(value.snapshotSha256 ?? "");
}

function assertReadinessShape(readiness, expected) {
  if (
    !exactKeys(readiness, [
      "audit",
      "base",
      "candidateCommit",
      "candidateReceiptSha256",
      "candidateTree",
      "devBuildArtifacts",
      "displayBuild",
      "obsidianReviewSha256",
      "publishedHistory",
      "pushReceiptSha256",
      "semanticEvidenceSha256",
      "verifiedAt",
      "version",
    ])
    || readiness.audit !== "public-release-readiness-v1"
    || readiness.version !== expected.version
    || readiness.base !== expected.base
    || readiness.candidateCommit !== expected.candidate
    || readiness.candidateTree !== expected.tree
    || !SHA_256.test(readiness.candidateReceiptSha256 ?? "")
    || !SHA_256.test(readiness.obsidianReviewSha256 ?? "")
    || !SHA_256.test(readiness.pushReceiptSha256 ?? "")
    || !SHA_256.test(readiness.semanticEvidenceSha256 ?? "")
    || typeof readiness.displayBuild !== "string"
    || readiness.displayBuild.length < 10
    || !ISO_TIME.test(readiness.verifiedAt ?? "")
    || !Number.isFinite(Date.parse(readiness.verifiedAt))
    || !exactKeys(readiness.devBuildArtifacts, ["mainJsSha256", "manifestSha256", "stylesCssSha256"])
    || Object.values(readiness.devBuildArtifacts).some((hash) => !SHA_256.test(hash ?? ""))
    || !isCanonicalPublishedHistory(readiness.publishedHistory)
    || comparePublicVersions(readiness.publishedHistory.lastTag, expected.version) >= 0
  ) throw new Error("Signed release authorization contains invalid readiness evidence");
}

function authorizationSigningBytes(envelope) {
  const unsigned = {
    approval: envelope.approval,
    approvalSha256: envelope.approvalSha256,
    audit: envelope.audit,
    authorization: {
      algorithm: envelope.authorization.algorithm,
      authorizedAt: envelope.authorization.authorizedAt,
      expiresAt: envelope.authorization.expiresAt,
      keyId: envelope.authorization.keyId,
    },
    readiness: envelope.readiness,
    readinessSha256: envelope.readinessSha256,
    releaseEnvironment: envelope.releaseEnvironment,
  };
  return Buffer.concat([
    Buffer.from(RELEASE_AUTHORIZATION_DOMAIN, "utf8"),
    canonicalReleaseEvidenceBytes(unsigned),
  ]);
}

export function releaseAuthorizationSigningBytes(envelope) {
  return authorizationSigningBytes(envelope);
}

export function assertAuthorizedReleaseEvidence(
  bytes,
  expected,
  keyring = RELEASE_AUTHORIZATION_KEYRING,
  verification = {},
) {
  if (!Buffer.isBuffer(bytes)) throw new Error("Signed release authorization must be supplied as bytes");
  if (
    !exactKeys(expected, ["base", "candidate", "tree", "version"])
    || !PUBLIC_VERSION_RE.test(expected.version ?? "")
    || !SHA_1.test(expected.base ?? "")
    || !SHA_1.test(expected.candidate ?? "")
    || !SHA_1.test(expected.tree ?? "")
  ) throw new Error("Signed release authorization verifier received an invalid exact binding");
  if (bytes.length === 0 || bytes[0] === 0xef || bytes.includes(0)) {
    throw new Error("Signed release authorization has an invalid byte encoding");
  }
  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Signed release authorization is not valid UTF-8 JSON");
  }
  if (!bytes.equals(canonicalReleaseEvidenceBytes(envelope))) {
    throw new Error("Signed release authorization bytes are not the one canonical JSON encoding");
  }
  if (
    !exactKeys(envelope, [
      "approval",
      "approvalSha256",
      "audit",
      "authorization",
      "readiness",
      "readinessSha256",
      "releaseEnvironment",
    ])
    || envelope.audit !== "public-release-authorization-v1"
    || !exactKeys(envelope.authorization, ["algorithm", "authorizedAt", "expiresAt", "keyId", "signature"])
    || envelope.authorization.algorithm !== "Ed25519"
    || !ISO_TIME.test(envelope.authorization.authorizedAt ?? "")
    || !Number.isFinite(Date.parse(envelope.authorization.authorizedAt))
    || !ISO_TIME.test(envelope.authorization.expiresAt ?? "")
    || !Number.isFinite(Date.parse(envelope.authorization.expiresAt))
    || !SHA_256.test(envelope.approvalSha256 ?? "")
    || !SHA_256.test(envelope.readinessSha256 ?? "")
    || !exactKeys(envelope.releaseEnvironment, ["branch", "name", "preventSelfReview", "reviewer", "reviewerId"])
    || envelope.releaseEnvironment.name !== "butter-editor-production"
    || envelope.releaseEnvironment.branch !== "master"
    || envelope.releaseEnvironment.reviewer !== "Giblicious"
    || envelope.releaseEnvironment.reviewerId !== RELEASE_ENVIRONMENT_REVIEWER_ID
    || envelope.releaseEnvironment.preventSelfReview !== false
    || !exactKeys(envelope.approval, [
      "approvedAt",
      "approver",
      "audit",
      "base",
      "candidateCommit",
      "candidateTree",
      "conclusion",
      "readinessSha256",
      "version",
    ])
    || envelope.approval.audit !== "public-final-publish-approval-v1"
    || envelope.approval.approver !== "admin@buttereditor.com"
    || envelope.approval.conclusion !== "approve"
    || envelope.approval.version !== expected.version
    || envelope.approval.base !== expected.base
    || envelope.approval.candidateCommit !== expected.candidate
    || envelope.approval.candidateTree !== expected.tree
    || envelope.approval.readinessSha256 !== envelope.readinessSha256
    || !ISO_TIME.test(envelope.approval.approvedAt ?? "")
    || !Number.isFinite(Date.parse(envelope.approval.approvedAt))
  ) throw new Error("Signed release authorization has an invalid exact schema or approval binding");

  assertReadinessShape(envelope.readiness, expected);
  const runAttempt = verification.runAttempt ?? 1;
  const verifiedNow = verification.now ?? Date.now();
  if (
    !verification
    || typeof verification !== "object"
    || Array.isArray(verification)
    || Object.keys(verification).some((key) => !["now", "runAttempt"].includes(key))
    || !Number.isSafeInteger(runAttempt)
    || runAttempt < 1
    || !Number.isFinite(verifiedNow)
  ) throw new Error("Signed release authorization verifier received invalid run-attempt context");
  const authorizedAt = Date.parse(envelope.authorization.authorizedAt);
  const expiresAt = Date.parse(envelope.authorization.expiresAt);
  if (
    sha256(canonicalReleaseEvidenceBytes(envelope.readiness)) !== envelope.readinessSha256
    || sha256(canonicalReleaseEvidenceBytes(envelope.approval)) !== envelope.approvalSha256
    || Date.parse(envelope.approval.approvedAt) < Date.parse(envelope.readiness.verifiedAt)
    || authorizedAt < Date.parse(envelope.approval.approvedAt)
    || expiresAt !== authorizedAt + RELEASE_AUTHORIZATION_TTL_MS
    || authorizedAt > verifiedNow + 5 * 60 * 1000
    || verifiedNow > expiresAt
  ) throw new Error("Signed release authorization hashes or chronology are invalid");

  const keyId = envelope.authorization.keyId;
  const publicSpki = keyring && typeof keyring === "object" && !Array.isArray(keyring)
    && Object.prototype.hasOwnProperty.call(keyring, keyId)
    ? keyring[keyId]
    : undefined;
  if (!SHA_256.test(keyId ?? "") || typeof publicSpki !== "string") {
    throw new Error("Signed release authorization uses an untrusted key identity");
  }
  const publicDer = Buffer.from(publicSpki, "base64");
  if (
    publicDer.toString("base64") !== publicSpki
    || sha256(publicDer) !== keyId
  ) throw new Error("Pinned release authorization key is invalid");
  let signature;
  let publicKey;
  try {
    signature = Buffer.from(envelope.authorization.signature ?? "", "base64");
    publicKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
  } catch {
    throw new Error("Signed release authorization signature or public key is invalid");
  }
  if (
    signature.length !== 64
    || signature.toString("base64") !== envelope.authorization.signature
    || !verify(null, authorizationSigningBytes(envelope), publicKey, signature)
  ) throw new Error("Signed release authorization signature is invalid");
  return envelope;
}

function operatingSystemEnvironment(source = process.env) {
  const env = {};
  for (const key of [
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "PATH",
    "Path",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "SystemDrive",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TZ",
    "WINDIR",
  ]) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

export function assertNoNodeInjectionEnvironment(environment = process.env) {
  const found = Object.keys(environment).filter((key) => NODE_INJECTION_ENVIRONMENT.test(key));
  if (found.length > 0) {
    throw new Error(`Node preload/injection environment is forbidden for release authority: ${found.sort().join(", ")}`);
  }
}

export function assertNoGitObjectOverlayEnvironment(environment = process.env) {
  const found = Object.keys(environment).filter((key) => GIT_OBJECT_OVERLAY_ENVIRONMENT.test(key));
  if (found.length > 0) {
    throw new Error(`Git repository/object overlay environment is forbidden for release authority: ${found.sort().join(", ")}`);
  }
}

function readSmallGitMetadata(path, label) {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > 1024 * 1024) {
    throw new Error(`${label} must be a small regular unlinked file`);
  }
  const bytes = readFileSync(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
}

function entryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function rawGitConfigKeys(content, label) {
  const keys = [];
  let section = "";
  let subsection = "";
  for (const sourceLine of content.split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.endsWith("\\")) throw new Error(`${label} may not contain continuation lines`);
    if (line.startsWith("[")) {
      const match = /^\[([A-Za-z0-9.-]+)(?:\s+"([^"\r\n]+)")?\]$/u.exec(line);
      if (!match || match[2]?.includes(String.fromCharCode(92))) {
        throw new Error(`${label} contains an unsupported section declaration`);
      }
      section = match[1].toLowerCase();
      subsection = (match[2] ?? "").toLowerCase();
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=|$)/u.exec(line);
    if (!section || !match) throw new Error(`${label} contains an unsupported configuration line`);
    keys.push([section, subsection, match[1].toLowerCase()].filter(Boolean).join("."));
  }
  return keys;
}

export function assertNoRepositoryGitMetadataOverlays(root, workspaceRoot) {
  const dotGit = join(root, ".git");
  if (!entryExists(dotGit)) throw new Error("Repository .git metadata is missing");
  const dotGitStats = lstatSync(dotGit);
  let gitDir;
  let commonDir;
  if (dotGitStats.isDirectory() && !dotGitStats.isSymbolicLink()) {
    gitDir = dotGit;
    commonDir = dotGit;
  } else if (dotGitStats.isFile() && !dotGitStats.isSymbolicLink() && dotGitStats.nlink === 1) {
    const pointer = readSmallGitMetadata(dotGit, "Linked-worktree .git pointer");
    const pointerMatch = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(pointer);
    if (!pointerMatch || !isAbsolute(pointerMatch[1])) {
      throw new Error("Linked-worktree .git pointer must name one absolute Git directory");
    }
    gitDir = resolve(pointerMatch[1]);
    const commonPointer = join(gitDir, "commondir");
    if (!entryExists(commonPointer)) throw new Error("Linked-worktree common-directory pointer is missing");
    const commonValue = readSmallGitMetadata(commonPointer, "Linked-worktree common-directory pointer");
    const commonMatch = /^([^\r\n]+)\r?\n?$/u.exec(commonValue);
    if (!commonMatch || isAbsolute(commonMatch[1])) {
      throw new Error("Linked-worktree common-directory pointer must be one relative path");
    }
    commonDir = resolve(gitDir, commonMatch[1]);
  } else {
    throw new Error("Repository .git metadata is linked or has an invalid type");
  }

  const realWorkspace = realpathSync(workspaceRoot);
  for (const [label, path] of [["Git directory", gitDir], ["Git common directory", commonDir]]) {
    if (!entryExists(path)) throw new Error(`${label} is missing before repository verification`);
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink() || !isWithin(realWorkspace, realpathSync(path))) {
      throw new Error(`${label} is linked, invalid, or outside the WDM workspace`);
    }
  }
  for (const directory of new Set([realpathSync(gitDir), realpathSync(commonDir)])) {
    for (const name of ["alternates", "http-alternates"]) {
      if (entryExists(join(directory, "objects", "info", name))) {
        throw new Error(`Git object ${name} overlay is forbidden for release authority`);
      }
    }
    for (const name of ["config", "config.worktree"]) {
      const config = join(directory, name);
      if (!entryExists(config)) continue;
      const content = readSmallGitMetadata(config, `Git ${name}`);
      const dangerous = rawGitConfigKeys(content, `Git ${name}`).filter((key) => (
        DANGEROUS_LOCAL_GIT_CONFIG.test(key)
      ));
      if (dangerous.length > 0) {
        throw new Error(`Release-affecting raw Git configuration is forbidden: ${dangerous.join(", ")}`);
      }
    }
  }
}

function pathWithTrustedGit(gitExe, source = process.env) {
  const original = source.Path ?? source.PATH ?? "";
  return [dirname(gitExe), original].filter(Boolean).join(delimiter);
}

function scrubbedGitEnvironment(home, gitExe) {
  const env = operatingSystemEnvironment();
  env.PATH = pathWithTrustedGit(gitExe);
  delete env.Path;
  env.GCM_INTERACTIVE = "Never";
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = join(home, "empty-git-config");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = home;
  return env;
}

function git(gitExe, publicRoot, home, hooks, args, options = {}) {
  return execFileSync(
    gitExe,
    [
      "-c",
      `safe.directory=${slash(publicRoot)}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${slash(hooks)}`,
      "-C",
      publicRoot,
      ...args,
    ],
    {
      encoding: options.encoding ?? "utf8",
      env: scrubbedGitEnvironment(home, gitExe),
      input: options.input,
      maxBuffer: 64 * 1024 * 1024,
      stdio: options.stdio ?? [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    },
  );
}

function gitText(gitExe, publicRoot, home, hooks, args) {
  return git(gitExe, publicRoot, home, hooks, args).trim();
}

function networkGit(gitExe, home, args, options = {}) {
  return execFileSync(gitExe, args, {
    cwd: home,
    encoding: options.encoding ?? "utf8",
    env: scrubbedGitEnvironment(home, gitExe),
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function networkGitText(gitExe, home, args) {
  return networkGit(gitExe, home, args).trim();
}

function assertNoDangerousLocalGitConfig(gitExe, publicRoot, home, hooks) {
  const keys = gitText(gitExe, publicRoot, home, hooks, [
    "config",
    "--local",
    "--includes",
    "--name-only",
    "--list",
  ]).split(/\r?\n/u).filter(Boolean);
  const dangerous = keys.filter((key) => DANGEROUS_LOCAL_GIT_CONFIG.test(key));
  if (dangerous.length > 0) {
    throw new Error(`Release-affecting local Git configuration is forbidden:\n${dangerous.join("\n")}`);
  }
}

function exactGitBlob(gitExe, publicRoot, home, hooks, commit, path) {
  const record = gitText(gitExe, publicRoot, home, hooks, ["ls-tree", commit, "--", path]);
  if (!/^100644 blob [0-9a-f]{40}\t/u.test(record)) {
    throw new Error(`Trusted public control is missing or not mode 100644: ${path}`);
  }
  return git(gitExe, publicRoot, home, hooks, ["show", `${commit}:${path}`], { encoding: "buffer" });
}

function assertRegularUnlinkedFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) throw new Error(`${label} must be a regular unlinked file: ${path}`);
  realpathSync(path);
}

function samePathText(left, right) {
  const normalize = (value) => resolve(value).replace(/\\/gu, "/");
  return process.platform === "win32"
    ? normalize(left).toLowerCase() === normalize(right).toLowerCase()
    : normalize(left) === normalize(right);
}

export function pinnedDependencyEntryDigest(root) {
  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot)) throw new Error(`Pinned dependency root is missing: ${resolvedRoot}`);
  const rootStats = lstatSync(resolvedRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Pinned dependency root must be an unlinked directory: ${resolvedRoot}`);
  }
  const realRoot = realpathSync(resolvedRoot);
  if (!samePathText(realRoot, resolvedRoot)) {
    throw new Error(`Pinned dependency root must not resolve through a link: ${resolvedRoot}`);
  }
  const entries = [];
  const caseFolded = new Set();
  let directoryCount = 0;
  let fileCount = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = slash(relative(resolvedRoot, path));
      const folded = relativePath.toLowerCase();
      if (caseFolded.has(folded)) {
        throw new Error(`Pinned dependency contains a case-folding path collision: ${relativePath}`);
      }
      caseFolded.add(folded);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink() || !samePathText(realpathSync(path), path)) {
        throw new Error(`Pinned dependency contains a linked or reparse entry: ${relativePath}`);
      }
      if (stats.isDirectory()) {
        directoryCount++;
        entries.push({ digest: `D\0${relativePath}\n`, relativePath });
        visit(path);
      } else if (stats.isFile()) {
        if (stats.nlink !== 1) {
          throw new Error(`Pinned dependency contains a hard-linked file: ${relativePath}`);
        }
        if (relativePath !== "manifest.json") {
          const bytes = readFileSync(path);
          if (bytes.length !== stats.size) {
            throw new Error(`Pinned dependency file changed during hashing: ${relativePath}`);
          }
          fileCount++;
          entries.push({
            digest: `F\0${relativePath}\0${stats.size}\0${sha256(bytes)}\n`,
            relativePath,
          });
        }
      } else {
        throw new Error(`Pinned dependency contains a non-file entry: ${relativePath}`);
      }
    }
  };
  visit(resolvedRoot);
  entries.sort((left, right) => (
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0
  ));
  return {
    directoryCount,
    fileCount,
    sha256: sha256(Buffer.from(entries.map((entry) => entry.digest).join(""), "utf8")),
  };
}

function validatePinnedDependency(wdmRoot, id) {
  const expected = PINNED_WDM_DEPENDENCIES[id];
  if (!expected) throw new Error(`Unknown pinned WDM dependency: ${id}`);
  const root = resolve(wdmRoot, ".wdm-app", "deps", id);
  const manifestPath = join(root, "manifest.json");
  assertRegularUnlinkedFile(manifestPath, `${id} dependency manifest`);
  const manifestBytes = readFileSync(manifestPath);
  if (sha256(manifestBytes) !== expected.manifestSha256) {
    throw new Error(`Pinned ${id} dependency manifest hash mismatch`);
  }
  const manifest = parseTrustedJson(manifestBytes, `Pinned ${id} dependency manifest`);
  if (
    manifest.schemaVersion !== 1
    || manifest.id !== id
    || manifest.version !== expected.version
    || manifest.command !== expected.command
  ) throw new Error(`Pinned ${id} dependency manifest identity is invalid`);
  const digest = pinnedDependencyEntryDigest(root);
  if (
    digest.directoryCount !== expected.directoryCount
    || digest.fileCount !== expected.fileCount
    || digest.sha256 !== expected.treeSha256
  ) throw new Error(`Pinned ${id} dependency tree differs from the approved WDM runtime`);
  return { manifest, root };
}

export function validateTrustedWdmRuntime(wdmRoot, sourceEnvironment = process.env) {
  const resolvedRoot = resolve(wdmRoot);
  if (!isAbsolute(resolvedRoot) || !existsSync(resolvedRoot)) {
    throw new Error("WDM root must be an existing absolute path");
  }
  const stats = lstatSync(resolvedRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink() || !samePathText(realpathSync(resolvedRoot), resolvedRoot)) {
    throw new Error("WDM root must be an unlinked canonical directory");
  }
  const git = validatePinnedDependency(resolvedRoot, "git");
  const gh = validatePinnedDependency(resolvedRoot, "gh");
  const npm = validatePinnedDependency(resolvedRoot, "npm");
  if (
    JSON.stringify(npm.manifest.args)
      !== JSON.stringify([".wdm-app/deps/npm/node_modules/npm/bin/npm-cli.js"])
  ) throw new Error("Pinned npm dependency arguments are invalid");
  const gitExe = resolve(git.root, git.manifest.command);
  const ghExe = resolve(gh.root, gh.manifest.command);
  const nodeExe = resolve(npm.root, npm.manifest.command);
  const npmCli = resolve(resolvedRoot, npm.manifest.args[0]);
  const npxCli = resolve(dirname(npmCli), "npx-cli.js");
  assertRegularUnlinkedFile(gitExe, "pinned Git executable");
  assertRegularUnlinkedFile(ghExe, "pinned GitHub CLI executable");
  assertRegularUnlinkedFile(nodeExe, "pinned Node executable");
  assertRegularUnlinkedFile(npmCli, "pinned npm CLI");
  assertRegularUnlinkedFile(npxCli, "pinned npx CLI");
  const nodeSha256 = sha256(readFileSync(nodeExe));
  if (nodeSha256 !== PINNED_NODE_EXE_SHA256) {
    throw new Error(`Pinned Node executable hash mismatch: expected ${PINNED_NODE_EXE_SHA256}, found ${nodeSha256}`);
  }
  if (!samePathText(process.execPath, nodeExe)) {
    throw new Error(`Trusted release launcher must run under the pinned WDM Node executable: ${nodeExe}`);
  }
  return Object.freeze({
    ghExe,
    ghSha256: sha256(readFileSync(ghExe)),
    gitExe,
    gitSha256: sha256(readFileSync(gitExe)),
    nodeExe,
    npmCli,
    npmCliSha256: sha256(readFileSync(npmCli)),
    npxCli,
    npxCliSha256: sha256(readFileSync(npxCli)),
    reparseTestRoot: trustedWindowsReparseTestRoot(sourceEnvironment),
    wdmRoot: resolvedRoot,
  });
}

export function trustedWindowsReparseTestRoot(source = process.env) {
  if (process.platform !== "win32") {
    throw new Error("The trusted release test runtime requires Windows junction support");
  }
  const localAppData = source.LOCALAPPDATA;
  if (typeof localAppData !== "string" || !isAbsolute(localAppData)) {
    throw new Error("LOCALAPPDATA must name one absolute Windows directory before environment scrubbing");
  }
  const resolvedLocalAppData = resolve(localAppData);
  const resolvedRoot = resolve(resolvedLocalAppData, "Temp");
  for (const [path, label] of [
    [resolvedLocalAppData, "LOCALAPPDATA"],
    [resolvedRoot, "LOCALAPPDATA reparse-test root"],
  ]) {
    if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink() || !samePathText(realpathSync(path), path)) {
      throw new Error(`${label} must be a canonical unlinked directory`);
    }
  }
  if (dirname(resolvedRoot) !== resolvedLocalAppData) {
    throw new Error("The trusted reparse-test root must be the direct LOCALAPPDATA Temp child");
  }
  return resolvedRoot;
}

function assertUnlinkedGitEntry(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  const stats = lstatSync(path);
  if ((!stats.isFile() && !stats.isDirectory()) || stats.isSymbolicLink() || (stats.isFile() && stats.nlink !== 1)) {
    throw new Error(`${label} must be an unlinked file or directory: ${path}`);
  }
  realpathSync(path);
}

function isWithin(parent, child) {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

export function parseLauncherArgs(argv) {
  const separator = argv.indexOf("--");
  const own = separator < 0 ? argv : argv.slice(0, separator);
  const forwarded = separator < 0 ? [] : argv.slice(separator + 1);
  const values = {};
  for (let index = 1; index < own.length; index += 2) {
    const key = own[index];
    const value = own[index + 1];
    if (!/^--[a-z0-9-]+$/u.test(key ?? "") || value === undefined || values[key] !== undefined) {
      throw new Error("Trusted launcher options must be unique --name value pairs");
    }
    values[key] = value;
  }
  const exactKeys = [
    "--control",
    "--launcher-sha256",
    "--private-root",
    "--public-root",
    "--trusted-master",
    "--wdm-root",
  ];
  if (JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(exactKeys.sort())) {
    throw new Error(`Trusted launcher requires exactly: ${exactKeys.join(", ")}`);
  }
  if (!CONTROL_TARGETS.has(values["--control"]) || !SHA_1.test(values["--trusted-master"])) {
    throw new Error("Trusted launcher control name or master SHA is invalid");
  }
  return {
    control: values["--control"],
    forwarded,
    launcherSha256: values["--launcher-sha256"],
    privateRoot: resolve(values["--private-root"]),
    publicRoot: resolve(values["--public-root"]),
    trustedMaster: values["--trusted-master"],
    wdmRoot: resolve(values["--wdm-root"]),
  };
}

function writeExact(root, relativePath, bytes) {
  const output = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, bytes, { flag: "wx", mode: 0o600 });
}

function parseTrustedJson(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("root value is not an object");
    }
    return value;
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${errorText(error)}`);
  }
}

export function validateTrustedPackageForInstall(packageBytes, lockBytes) {
  const packageJson = parseTrustedJson(packageBytes, "Trusted package.json");
  const packageLock = parseTrustedJson(lockBytes, "Trusted package-lock.json");
  const packageName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
  const registrySpecifier = /^(?:(?:\^|~)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?|latest)$/u;
  for (const field of ["dependencies", "devDependencies"]) {
    const record = packageJson[field] ?? {};
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`Trusted package ${field} is not a dependency record`);
    }
    for (const [name, specifier] of Object.entries(record)) {
      if (
        name.length > 214
        || !packageName.test(name)
        || typeof specifier !== "string"
        || !registrySpecifier.test(specifier)
      ) throw new Error(`Trusted package has an unsafe registry request: ${field}.${name}`);
    }
  }
  if (packageLock.lockfileVersion !== 3 || !packageLock.packages || typeof packageLock.packages !== "object") {
    throw new Error("Trusted package lock must use npm lockfileVersion 3");
  }
  for (const [path, entry] of Object.entries(packageLock.packages)) {
    if (!path) continue;
    if (
      !/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/u.test(path)
      ||
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || typeof entry.resolved !== "string"
      || !entry.resolved.startsWith("https://registry.npmjs.org/")
      || typeof entry.integrity !== "string"
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity)
      || entry.link === true
    ) throw new Error(`Trusted package lock contains an unsafe resolution: ${path}`);
  }
  return { packageJson, packageLock };
}

export function validateLauncherPaths(options, sourceEnvironment = process.env) {
  if (process.version !== REQUIRED_NODE_VERSION) {
    throw new Error(`Trusted release launcher requires Node ${REQUIRED_NODE_VERSION}; found ${process.version}`);
  }
  for (const [label, path] of [
    ["private root", options.privateRoot],
    ["public root", options.publicRoot],
    ["WDM root", options.wdmRoot],
  ]) {
    if (!isAbsolute(path) || !existsSync(path)) throw new Error(`${label} must be an existing absolute path`);
    const resolvedPath = resolve(path);
    const stats = lstatSync(resolvedPath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error(`${label} must be an unlinked directory`);
    if (!samePathText(realpathSync(resolvedPath), resolvedPath)) {
      throw new Error(`${label} must not traverse a junction, reparse point, or alias`);
    }
  }
  if (!isWithin(options.wdmRoot, options.privateRoot) || !isWithin(options.wdmRoot, options.publicRoot)) {
    throw new Error("Release repositories must stay inside the WDM root");
  }
  if (dirname(options.privateRoot) !== dirname(options.publicRoot)) {
    throw new Error("Private and public release repositories must be sibling paths");
  }
  const expectedPublicRoot = resolve(dirname(options.privateRoot), "btr-pmx-public");
  if (options.publicRoot !== expectedPublicRoot) {
    throw new Error(`Public root must be the canonical sibling checkout: ${expectedPublicRoot}`);
  }
  for (const [label, root] of [["private", options.privateRoot], ["public", options.publicRoot]]) {
    const dotGit = join(root, ".git");
    assertUnlinkedGitEntry(dotGit, `${label} .git entry`);
  }
  return validateTrustedWdmRuntime(options.wdmRoot, sourceEnvironment);
}

export function validateTrustedGitExecutable(path, expectedSha256) {
  if (!isAbsolute(path) || !SHA_256.test(expectedSha256 ?? "")) {
    throw new Error("Trusted Git binding requires an absolute executable and lowercase SHA-256");
  }
  const resolved = resolve(path);
  assertRegularUnlinkedFile(resolved, "trusted Git executable");
  const actual = sha256(readFileSync(resolved));
  if (actual !== expectedSha256) {
    throw new Error(`Trusted Git executable hash mismatch: expected ${expectedSha256}, found ${actual}`);
  }
  return resolved;
}

function sameRealPath(left, right) {
  const normalize = (value) => {
    const real = realpathSync(resolve(value));
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  return normalize(left) === normalize(right);
}

export function assertRepositoryProvenance({ gitExe, home, hooks, kind, root, workspaceRoot }) {
  assertNoGitObjectOverlayEnvironment();
  assertNoRepositoryGitMetadataOverlays(root, workspaceRoot);
  const realWorkspace = realpathSync(workspaceRoot);
  const realRoot = realpathSync(root);
  if (!isWithin(realWorkspace, realRoot)) {
    throw new Error(`${kind} worktree resolves outside the intended WDM workspace`);
  }
  const topLevel = gitText(gitExe, root, home, hooks, ["rev-parse", "--show-toplevel"]);
  if (!sameRealPath(topLevel, realRoot)) {
    throw new Error(`${kind} Git top-level differs from the intended worktree: ${topLevel}`);
  }
  if (
    gitText(gitExe, root, home, hooks, ["rev-parse", "--is-inside-work-tree"]) !== "true"
    || gitText(gitExe, root, home, hooks, ["rev-parse", "--is-bare-repository"]) !== "false"
    || gitText(gitExe, root, home, hooks, ["rev-parse", "--show-superproject-working-tree"]) !== ""
  ) throw new Error(`${kind} repository must be a standalone non-bare worktree`);

  const gitDirText = gitText(gitExe, root, home, hooks, ["rev-parse", "--absolute-git-dir"]);
  const commonDirText = gitText(gitExe, root, home, hooks, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (!isAbsolute(gitDirText) || !isAbsolute(commonDirText)) {
    throw new Error(`${kind} Git directory/common directory must be absolute`);
  }
  const gitDir = resolve(gitDirText);
  const commonDir = resolve(commonDirText);
  for (const [label, path] of [["Git directory", gitDir], ["Git common directory", commonDir]]) {
    if (!existsSync(path) || !lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) {
      throw new Error(`${kind} ${label} is missing, linked, or not a directory: ${path}`);
    }
    if (!isWithin(realWorkspace, realpathSync(path))) {
      throw new Error(`${kind} ${label} resolves outside the WDM workspace: ${path}`);
    }
  }

  const dotGit = join(root, ".git");
  if (kind === "public") {
    if (!lstatSync(dotGit).isDirectory() || lstatSync(dotGit).isSymbolicLink()) {
      throw new Error("Canonical public checkout must be a standalone repository with an unlinked .git directory");
    }
    if (!sameRealPath(gitDir, dotGit) || !sameRealPath(commonDir, dotGit)) {
      throw new Error("Canonical public checkout Git directory/common directory must equal its own .git directory");
    }
  } else if (kind === "private") {
    const canonicalPrivateRoot = dirname(commonDir);
    const canonicalPrivateGit = join(canonicalPrivateRoot, ".git");
    if (
      basename(commonDir) !== ".git"
      || !sameRealPath(dirname(canonicalPrivateRoot), dirname(root))
      || !existsSync(canonicalPrivateRoot)
      || !lstatSync(canonicalPrivateRoot).isDirectory()
      || lstatSync(canonicalPrivateRoot).isSymbolicLink()
      || !existsSync(canonicalPrivateGit)
      || !lstatSync(canonicalPrivateGit).isDirectory()
      || lstatSync(canonicalPrivateGit).isSymbolicLink()
      || !isWithin(realWorkspace, realpathSync(canonicalPrivateGit))
    ) {
      throw new Error("Canonical local-control Git common directory is missing or has invalid topology");
    }
    if (
      sameRealPath(root, canonicalPrivateRoot)
      || !lstatSync(dotGit).isFile()
      || lstatSync(dotGit).isSymbolicLink()
      || lstatSync(dotGit).nlink !== 1
    ) {
      throw new Error("Release authority requires a registered sibling private Git worktree");
    }
    if (!sameRealPath(commonDir, canonicalPrivateGit) || !isWithin(realpathSync(canonicalPrivateGit), realpathSync(gitDir))) {
      throw new Error("Private release worktree is not registered under the canonical private Git common directory");
    }
    const registeredWorktrees = gitText(gitExe, root, home, hooks, ["worktree", "list", "--porcelain"])
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
    if (!registeredWorktrees.some((path) => existsSync(path) && sameRealPath(path, canonicalPrivateRoot))) {
      throw new Error("Canonical local-control checkout is not registered as the main worktree");
    }
    const remotes = gitText(gitExe, root, home, hooks, ["remote"]).split(/\r?\n/u).filter(Boolean);
    const fetchUrls = gitText(gitExe, root, home, hooks, ["remote", "get-url", "--all", "origin"])
      .split(/\r?\n/u).filter(Boolean);
    const pushUrls = gitText(gitExe, root, home, hooks, ["remote", "get-url", "--push", "--all", "origin"])
      .split(/\r?\n/u).filter(Boolean);
    const fetchRefspecs = gitText(gitExe, root, home, hooks, [
      "config",
      "--local",
      "--get-all",
      "remote.origin.fetch",
    ]).split(/\r?\n/u).filter(Boolean);
    const remoteKeys = gitText(gitExe, root, home, hooks, [
      "config",
      "--local",
      "--name-only",
      "--get-regexp",
      "^remote\\.origin\\.",
    ]).split(/\r?\n/u).filter(Boolean).sort();
    if (
      JSON.stringify(remotes) !== JSON.stringify(["origin"])
      || fetchUrls.length !== 1
      || pushUrls.length !== 1
      || sha256(fetchUrls[0]) !== CANONICAL_LOCAL_CONTROL_REMOTE_SHA256
      || sha256(pushUrls[0]) !== CANONICAL_LOCAL_CONTROL_REMOTE_SHA256
      || JSON.stringify(fetchRefspecs) !== JSON.stringify(["+refs/heads/*:refs/remotes/origin/*"])
      || JSON.stringify(remoteKeys) !== JSON.stringify(["remote.origin.fetch", "remote.origin.url"])
    ) throw new Error("Local-control repository remote identity or configuration is not canonical");
  } else {
    throw new Error(`Unknown repository provenance kind: ${kind}`);
  }

  const registered = gitText(gitExe, root, home, hooks, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .some((path) => existsSync(path) && sameRealPath(path, realRoot));
  if (!registered) throw new Error(`${kind} worktree is not registered at its intended path`);
  assertNoDangerousLocalGitConfig(gitExe, root, home, hooks);
  return { commonDir, gitDir, topLevel: realRoot };
}

function runPinnedNpm(runtime, controlRoot, home, args) {
  const verifiedRuntime = validateTrustedWdmRuntime(runtime.wdmRoot);
  if (!isWithin(verifiedRuntime.wdmRoot, controlRoot)) throw new Error("Trusted runtime escaped the WDM root");
  const env = {
    CI: "true",
    HOME: home,
    PATH: [dirname(verifiedRuntime.nodeExe), dirname(verifiedRuntime.gitExe)].join(delimiter),
    USERPROFILE: home,
    npm_config_cache: join(home, "npm-cache"),
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_userconfig: join(home, "empty-npmrc"),
  };
  for (const key of ["COMSPEC", "PATHEXT", "SystemRoot", "TEMP", "TMP", "WINDIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  execFileSync(verifiedRuntime.nodeExe, [
    verifiedRuntime.npmCli,
    ...args,
  ], {
    cwd: controlRoot,
    env,
    stdio: "inherit",
  });
}

async function runPrivateControl(options) {
  assertNoNodeInjectionEnvironment();
  const invokedPath = fileURLToPath(import.meta.url);
  if (!SHA_256.test(options.launcherSha256)) {
    throw new Error("Trusted private-control launcher requires the exact public-master launcher hash");
  }
  assertRegularUnlinkedFile(invokedPath, "materialized trusted launcher");
  if (sha256(readFileSync(invokedPath)) !== options.launcherSha256) {
    throw new Error("Invoked launcher bytes do not match --launcher-sha256");
  }
  const runtime = validateLauncherPaths(options);
  const trustedGitExe = runtime.gitExe;
  const evidenceParent = join(dirname(options.privateRoot), ".wdm", "tmp");
  if (!existsSync(evidenceParent)) throw new Error(`Canonical WDM evidence directory is missing: ${evidenceParent}`);
  const evidenceStats = lstatSync(evidenceParent);
  if (
    !evidenceStats.isDirectory()
    || evidenceStats.isSymbolicLink()
    || !samePathText(realpathSync(evidenceParent), evidenceParent)
    || !isWithin(runtime.wdmRoot, evidenceParent)
  ) throw new Error("Canonical WDM evidence directory is linked, aliased, or outside the WDM root");
  const container = mkdtempSync(join(evidenceParent, "btr-trusted-control-"));
  const controlRoot = join(container, "runtime");
  const home = join(container, "home");
  const hooks = join(container, "empty-hooks");
  const transportRoot = join(container, "transport.git");
  mkdirSync(controlRoot);
  mkdirSync(home);
  mkdirSync(hooks);
  writeFileSync(join(home, "empty-git-config"), "", { flag: "wx", mode: 0o600 });
  writeFileSync(join(home, "empty-npmrc"), "", { flag: "wx", mode: 0o600 });
  try {
    assertNoRepositoryGitMetadataOverlays(options.privateRoot, options.wdmRoot);
    assertNoRepositoryGitMetadataOverlays(options.publicRoot, options.wdmRoot);
    assertRepositoryProvenance({
      gitExe: trustedGitExe,
      home,
      hooks,
      kind: "private",
      root: options.privateRoot,
      workspaceRoot: options.wdmRoot,
    });
    assertRepositoryProvenance({
      gitExe: trustedGitExe,
      home,
      hooks,
      kind: "public",
      root: options.publicRoot,
      workspaceRoot: options.wdmRoot,
    });
    networkGit(trustedGitExe, home, ["init", "--bare", transportRoot], { stdio: "ignore" });
    const advertisedBefore = networkGitText(trustedGitExe, home, [
      "ls-remote",
      "--refs",
      CANONICAL_PUBLIC_REMOTE,
      "refs/heads/master",
    ]).split(/\s+/u)[0] ?? "";
    if (advertisedBefore !== options.trustedMaster) {
      throw new Error(`Trusted public master moved: expected ${options.trustedMaster}, found ${advertisedBefore || "<missing>"}`);
    }
    const trustedRef = `refs/btr/trusted-controls/${options.trustedMaster}`;
    git(trustedGitExe, transportRoot, home, hooks, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      CANONICAL_PUBLIC_REMOTE,
      `+refs/heads/master:${trustedRef}`,
    ], { stdio: "inherit" });
    const fetched = gitText(trustedGitExe, transportRoot, home, hooks, ["rev-parse", `${trustedRef}^{commit}`]);
    const advertisedAfter = networkGitText(trustedGitExe, home, [
      "ls-remote",
      "--refs",
      CANONICAL_PUBLIC_REMOTE,
      "refs/heads/master",
    ]).split(/\s+/u)[0] ?? "";
    if (fetched !== options.trustedMaster || advertisedAfter !== options.trustedMaster) {
      throw new Error("Trusted public master changed during control materialization");
    }
    const trustedLauncherBytes = exactGitBlob(
      trustedGitExe,
      transportRoot,
      home,
      hooks,
      options.trustedMaster,
      ".github/scripts/build-public-candidate.mjs",
    );
    if (sha256(trustedLauncherBytes) !== options.launcherSha256) {
      throw new Error("Streamed launcher hash does not match the exact trusted public-master blob");
    }
    const masterBundle = join(container, "trusted-master.bundle");
    git(trustedGitExe, transportRoot, home, hooks, ["bundle", "create", masterBundle, trustedRef]);
    git(trustedGitExe, options.publicRoot, home, hooks, ["bundle", "unbundle", masterBundle], { stdio: "ignore" });

    const manifestBytes = exactGitBlob(
      trustedGitExe,
      transportRoot,
      home,
      hooks,
      options.trustedMaster,
      ".github/release-control-hashes.json",
    );
    let manifest;
    try {
      manifest = JSON.parse(manifestBytes.toString("utf8"));
    } catch (error) {
      throw new Error(`Trusted local-control manifest is invalid: ${errorText(error)}`);
    }
    const expectedKeys = [...LOCAL_CONTROL_PATHS.keys()].sort();
    if (
      manifest?.version !== 1
      || !manifest.controls
      || JSON.stringify(Object.keys(manifest.controls).sort()) !== JSON.stringify(expectedKeys)
    ) throw new Error("Trusted local-control manifest has an unexpected schema or keyset");

    const localBytes = new Map();
    for (const [name, relativePath] of LOCAL_CONTROL_PATHS) {
      const source = join(options.privateRoot, ...relativePath.split("/"));
      assertRegularUnlinkedFile(source, `private control ${name}`);
      const bytes = readFileSync(source);
      if (!SHA_256.test(manifest.controls[name] ?? "") || sha256(bytes) !== manifest.controls[name]) {
        throw new Error(`Private control differs from trusted public manifest: ${relativePath}`);
      }
      localBytes.set(relativePath, bytes);
    }

    for (const [privatePath, publicPath] of PUBLIC_SCRIPT_PATHS) {
      const bytes = exactGitBlob(trustedGitExe, transportRoot, home, hooks, options.trustedMaster, publicPath);
      const privateSource = join(options.privateRoot, ...privatePath.split("/"));
      assertRegularUnlinkedFile(privateSource, `mapped private control ${privatePath}`);
      if (sha256(readFileSync(privateSource)) !== sha256(bytes)) {
        throw new Error(`Mapped private control differs from trusted public master: ${privatePath}`);
      }
      writeExact(controlRoot, privatePath, bytes);
    }
    for (const [relativePath, bytes] of localBytes) writeExact(controlRoot, relativePath, bytes);
    const packageBytes = exactGitBlob(
      trustedGitExe,
      transportRoot,
      home,
      hooks,
      options.trustedMaster,
      "package.json",
    );
    const lockBytes = exactGitBlob(
      trustedGitExe,
      transportRoot,
      home,
      hooks,
      options.trustedMaster,
      "package-lock.json",
    );
    const trustedPackage = validateTrustedPackageForInstall(packageBytes, lockBytes);
    writeExact(controlRoot, "package.json", packageBytes);
    writeExact(controlRoot, "package-lock.json", lockBytes);
    const {
      assertSafePublicLockMetadata,
      assertSafePublicPackageMetadata,
    } = await import(pathToFileURL(join(controlRoot, "scripts", "public-export-shape.mjs")).href);
    assertSafePublicPackageMetadata(trustedPackage.packageJson, trustedPackage.packageJson.version);
    assertSafePublicLockMetadata(trustedPackage.packageLock, trustedPackage.packageJson.version);
    const lockRoot = trustedPackage.packageLock.packages?.[""];
    for (const field of ["dependencies", "devDependencies"]) {
      if (
        JSON.stringify(lockRoot?.[field] ?? {})
        !== JSON.stringify(trustedPackage.packageJson[field] ?? {})
      ) throw new Error(`Trusted package and lock disagree on ${field}`);
    }

    runPinnedNpm(runtime, controlRoot, home, ["ci", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund"]);
    runPinnedNpm(runtime, controlRoot, home, ["audit", "--audit-level=moderate"]);
    const target = join(controlRoot, ...CONTROL_TARGETS.get(options.control).split("/"));
    const childEnvironment = {
      ...operatingSystemEnvironment(),
      BTR_RELEASE_PRIVATE_ROOT: options.privateRoot,
      BTR_RELEASE_PUBLIC_ROOT: options.publicRoot,
      BTR_TRUSTED_CONTROL_ROOT: controlRoot,
      BTR_TRUSTED_GIT_EXE: trustedGitExe,
      BTR_TRUSTED_GIT_CONFIG: join(home, "empty-git-config"),
      BTR_TRUSTED_GIT_HOME: home,
      BTR_TRUSTED_GIT_SHA256: runtime.gitSha256,
      BTR_TRUSTED_NPM_CLI: runtime.npmCli,
      BTR_TRUSTED_NPM_CLI_SHA256: runtime.npmCliSha256,
      BTR_TRUSTED_NPX_CLI: runtime.npxCli,
      BTR_TRUSTED_NPX_CLI_SHA256: runtime.npxCliSha256,
      BTR_TRUSTED_PUBLIC_MASTER: options.trustedMaster,
      BTR_TRUSTED_REPARSE_TEST_ROOT: runtime.reparseTestRoot,
      BTR_WDM_ROOT: runtime.wdmRoot,
      BTR_WDM_GH_EXE: runtime.ghExe,
    };
    childEnvironment.PATH = pathWithTrustedGit(trustedGitExe);
    delete childEnvironment.Path;
    execFileSync(runtime.nodeExe, [target, ...options.forwarded], {
      cwd: options.privateRoot,
      env: childEnvironment,
      stdio: "inherit",
    });
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
}

async function buildPublicCandidate(rootArgument) {
  if (process.version !== REQUIRED_NODE_VERSION) {
    throw new Error(`Trusted public build requires Node ${REQUIRED_NODE_VERSION}; found ${process.version}`);
  }
  const root = rootArgument ? resolve(rootArgument) : "";
  if (!root) throw new Error("Usage: build-public-candidate.mjs <materialized-public-root>");
  const [{ default: esbuild }, { publicEsbuildOptions }] = await Promise.all([
    import("esbuild"),
    import("./public-export-shape.mjs"),
  ]);
  await esbuild.build(publicEsbuildOptions(root));
}

export function parseAuthorizationVerificationArgs(argv) {
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!/^--[a-z-]+$/u.test(key ?? "") || value === undefined || values[key] !== undefined) {
      throw new Error("Release authorization verification options must be unique --name value pairs");
    }
    values[key] = value;
  }
  const exact = [
    "--base",
    "--candidate",
    "--file",
    "--run-attempt",
    "--run-started-at",
    "--tree",
    "--version",
  ];
  if (JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(exact.sort())) {
    throw new Error(`Release authorization verification requires exactly: ${exact.join(", ")}`);
  }
  if (
    !PUBLIC_VERSION_RE.test(values["--version"])
    || !SHA_1.test(values["--base"] ?? "")
    || !SHA_1.test(values["--candidate"] ?? "")
    || !SHA_1.test(values["--tree"] ?? "")
    || !/^[1-9]\d*$/u.test(values["--run-attempt"] ?? "")
    || !GITHUB_RUN_TIME.test(values["--run-started-at"] ?? "")
    || !Number.isFinite(Date.parse(values["--run-started-at"]))
  ) throw new Error("Release authorization verification received an invalid binding");
  return {
    base: values["--base"],
    candidate: values["--candidate"],
    file: resolve(values["--file"]),
    runAttempt: Number(values["--run-attempt"]),
    runStartedAt: new Date(values["--run-started-at"]).toISOString(),
    tree: values["--tree"],
    version: values["--version"],
  };
}

function verifyReleaseAuthorizationFile(options) {
  assertRegularUnlinkedFile(options.file, "signed release authorization");
  return assertAuthorizedReleaseEvidence(readFileSync(options.file), {
    base: options.base,
    candidate: options.candidate,
    tree: options.tree,
    version: options.version,
  }, undefined, {
    now: Date.parse(options.runStartedAt),
    runAttempt: options.runAttempt,
  });
}

const directInvocation = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (directInvocation) {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === "--launch-bound-control") {
      await runPrivateControl(parseLauncherArgs(argv));
    } else if (argv[0] === "--verify-release-authorization") {
      const authorization = verifyReleaseAuthorizationFile(parseAuthorizationVerificationArgs(argv));
      console.log(`Signed release authorization verified for ${authorization.readiness.candidateCommit}`);
    } else {
      await buildPublicCandidate(argv[0]);
    }
  } catch (error) {
    console.error(errorText(error));
    process.exitCode = 1;
  }
}
