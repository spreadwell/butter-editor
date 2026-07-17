import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CANONICAL_PUBLIC_REMOTE = "https://github.com/spreadwell/butter-editor.git";
const PUBLISHED_VERSION_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const SHA_1 = /^[0-9a-f]{40}$/u;
// Historical public evidence: lightweight tags 0.9.4 and 0.9.5 both point to
// this exact commit, whose manifest says 0.9.5. Preserve only the 0.9.4
// minAppVersion mapping, and bind the exception to every observed object value.
const LEGACY_TAG_MANIFEST_EXCEPTIONS = Object.freeze({
  "0.9.4": Object.freeze({
    advertisedObject: "d81dde4b789096acd42ff6ff4663e7afe1bdcdba",
    manifestMinAppVersion: "1.4.5",
    manifestVersion: "0.9.5",
    targetCommit: "d81dde4b789096acd42ff6ff4663e7afe1bdcdba",
  }),
});

export function isPublishedVersionTag(tag) {
  return PUBLISHED_VERSION_RE.test(tag);
}

function compareVersions(left, right) {
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

function errorText(error) {
  if (!(error instanceof Error)) return String(error);
  const stderr = "stderr" in error && error.stderr
    ? String(error.stderr).trim()
    : "";
  return stderr || error.message;
}

function isolatedGitEnvironment(home) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_/iu.test(key) || /^(?:ALL|HTTP|HTTPS|NO)_PROXY$/iu.test(key) || /^(?:CURL_CA_BUNDLE|SSL_CERT_(?:DIR|FILE))$/iu.test(key)) delete env[key];
  }
  env.GCM_INTERACTIVE = "Never";
  env.GIT_ATTR_NOSYSTEM = "1";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = home;
  return env;
}

function gitText(repoRoot, args, env, hooks) {
  const absoluteRoot = resolve(repoRoot);
  try {
    return execFileSync(
      "git",
      [
        "-c",
        `safe.directory=${absoluteRoot.replace(/\\/gu, "/")}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${hooks.replace(/\\/gu, "/")}`,
        "-C",
        absoluteRoot,
        ...args,
      ],
      {
        encoding: "utf8",
        env,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  } catch (error) {
    throw new Error(`Git history inspection failed at ${absoluteRoot}: ${errorText(error)}`);
  }
}

function remoteSemverTags(env, cwd, hooks, remoteUrl) {
  let output;
  try {
    output = execFileSync(
      "git",
      [
        "-c",
        `core.hooksPath=${hooks.replace(/\\/gu, "/")}`,
        "ls-remote",
        "--refs",
        "--tags",
        remoteUrl,
      ],
      {
        cwd,
        encoding: "utf8",
        env,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  } catch (error) {
    throw new Error(`Could not read authoritative public release tags: ${errorText(error)}`);
  }
  const tags = new Map();
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    const match = /^([0-9a-f]{40})\trefs\/tags\/(.+)$/u.exec(line);
    if (!match) throw new Error(`Malformed remote tag advertisement: ${line}`);
    const [, object, tag] = match;
    if (!isPublishedVersionTag(tag)) continue;
    if (tags.has(tag)) throw new Error(`Duplicate remote release tag advertisement: ${tag}`);
    tags.set(tag, object);
  }
  if (tags.size === 0) throw new Error("The canonical public remote advertises no semver release tags");
  return new Map([...tags.entries()].sort(([left], [right]) => compareVersions(left, right)));
}

function readJsonGitBlob(repoRoot, ref, path, env, hooks, label) {
  const raw = gitText(repoRoot, ["show", `${ref}:${path}`], env, hooks);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorText(error)}`);
  }
}

export function findVersionHistoryErrors(versions, publishedManifests) {
  const failures = [];
  for (const { advertisedObject, tag, manifest, targetCommit } of publishedManifests) {
    const exception = LEGACY_TAG_MANIFEST_EXCEPTIONS[tag];
    const matchesException = exception !== undefined
      && advertisedObject === exception.advertisedObject
      && targetCommit === exception.targetCommit
      && manifest?.version === exception.manifestVersion
      && manifest?.minAppVersion === exception.manifestMinAppVersion;
    if (manifest?.version !== tag && !matchesException) {
      failures.push(`public tag ${tag} contains manifest version ${JSON.stringify(manifest?.version)}`);
    }
    const expectedMinAppVersion = manifest?.minAppVersion;
    if (typeof expectedMinAppVersion !== "string" || expectedMinAppVersion.trim() === "") {
      failures.push(`public tag ${tag} has no valid minAppVersion in manifest.json`);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(versions, tag)) {
      failures.push(
        `versions.json is missing published version ${tag}; add ${JSON.stringify(tag)}: ${JSON.stringify(expectedMinAppVersion)}`,
      );
      continue;
    }
    if (versions[tag] !== expectedMinAppVersion) {
      failures.push(
        `versions.json maps ${tag} to ${JSON.stringify(versions[tag])}; tagged manifest.json requires ${JSON.stringify(expectedMinAppVersion)}`,
      );
    }
  }
  return failures;
}

function inspectPublishedVersionHistory({
  auditParent = tmpdir(),
  excludedTag,
  versionsRef,
  versionsRepo,
}) {
  const validatesVersions = versionsRef !== undefined || versionsRepo !== undefined;
  if (validatesVersions && !SHA_1.test(versionsRef ?? "")) {
    throw new Error("Version-history validation requires an exact commit SHA");
  }
  if (validatesVersions && (typeof versionsRepo !== "string" || versionsRepo.length === 0)) {
    throw new Error("Version-history validation requires a versions repository");
  }
  if (excludedTag !== undefined && !isPublishedVersionTag(excludedTag)) {
    throw new Error("The excluded release tag must be bare semver");
  }
  const container = mkdtempSync(join(resolve(auditParent), "btr-public-history-"));
  const bare = join(container, "remote-tags.git");
  const hooks = join(container, "empty-hooks");
  const home = join(container, "home");
  mkdirSync(hooks);
  mkdirSync(home);
  const env = isolatedGitEnvironment(home);
  const remoteUrl = CANONICAL_PUBLIC_REMOTE;
  try {
    execFileSync("git", ["init", "--bare", bare], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const before = remoteSemverTags(env, container, hooks, remoteUrl);
    const refspecs = [...before.keys()].map((tag) => `+refs/tags/${tag}:refs/tags/${tag}`);
    gitText(bare, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      remoteUrl,
      ...refspecs,
    ], env, hooks);
    const after = remoteSemverTags(env, container, hooks, remoteUrl);
    if (JSON.stringify([...after]) !== JSON.stringify([...before])) {
      throw new Error("Public release tags moved during authoritative history capture");
    }

    const publishedManifests = [];
    for (const [tag, advertisedObject] of before) {
      const fetchedObject = gitText(bare, ["rev-parse", `refs/tags/${tag}`], env, hooks);
      if (fetchedObject !== advertisedObject) {
        throw new Error(`Fetched tag ${tag} differs from its authoritative advertisement`);
      }
      const targetCommit = gitText(bare, ["rev-parse", `refs/tags/${tag}^{commit}`], env, hooks);
      if (!SHA_1.test(targetCommit)) throw new Error(`Published tag ${tag} does not peel to a commit`);
      publishedManifests.push({
        advertisedObject,
        manifest: readJsonGitBlob(bare, targetCommit, "manifest.json", env, hooks, `tag ${tag} manifest.json`),
        tag,
        targetCommit,
      });
    }

    if (validatesVersions) {
      const versions = readJsonGitBlob(
        versionsRepo,
        versionsRef,
        "versions.json",
        env,
        hooks,
        `versions.json at ${versionsRef}`,
      );
      if (versions === null || typeof versions !== "object" || Array.isArray(versions)) {
        throw new Error(`versions.json at ${versionsRef} must contain a JSON object`);
      }
      const failures = findVersionHistoryErrors(versions, publishedManifests);
      if (failures.length > 0) {
        throw new Error([
          "Authoritative published-version history validation failed:",
          ...failures.map((failure) => `- ${failure}`),
        ].join("\n"));
      }
    }
    const snapshotEntries = publishedManifests.filter(({ tag }) => tag !== excludedTag);
    if (snapshotEntries.length === 0) {
      throw new Error("The authoritative published-version snapshot cannot be empty");
    }
    const tags = snapshotEntries.map(({ tag }) => tag);
    if (excludedTag !== undefined && compareVersions(excludedTag, tags.at(-1)) <= 0) {
      throw new Error(`Release version ${excludedTag} must be newer than authoritative tag ${tags.at(-1)}`);
    }
    const snapshotSha256 = createHash("sha256").update(JSON.stringify(
      snapshotEntries.map(({ advertisedObject, manifest, tag, targetCommit }) => ({
        advertisedObject,
        minAppVersion: manifest.minAppVersion,
        tag,
        targetCommit,
        version: manifest.version,
      })),
    )).digest("hex");
    return {
      lastTag: tags.at(-1),
      snapshotSha256,
      tagCount: tags.length,
      tags,
    };
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
}

export function capturePublishedVersionHistory(options = {}) {
  return inspectPublishedVersionHistory(options);
}

export function validatePublishedVersionHistory(options) {
  return inspectPublishedVersionHistory(options);
}

function parseCliArgs(argv) {
  if (argv.length === 1 && argv[0] === "--snapshot") return { mode: "snapshot" };
  if (
    argv.length === 3
    && argv[0] === "--snapshot"
    && argv[1] === "--exclude-tag"
    && isPublishedVersionTag(argv[2])
  ) {
    return { excludedTag: argv[2], mode: "snapshot" };
  }
  if (argv.length === 3 && argv[0] === "--validate") {
    return { mode: "validate", versionsRef: argv[2], versionsRepo: argv[1] };
  }
  if (
    argv.length === 5
    && argv[0] === "--validate"
    && argv[3] === "--exclude-tag"
    && isPublishedVersionTag(argv[4])
  ) {
    return {
      excludedTag: argv[4],
      mode: "validate",
      versionsRef: argv[2],
      versionsRepo: argv[1],
    };
  }
  throw new Error([
    "Usage:",
    "  node public-version-history.mjs --snapshot [--exclude-tag x.y.z]",
    "  node public-version-history.mjs --validate <versions-repository> <exact-commit-sha> [--exclude-tag x.y.z]",
  ].join("\n"));
}

function runCli(argv) {
  const options = parseCliArgs(argv);
  const result = options.mode === "validate"
    ? validatePublishedVersionHistory({
      auditParent: tmpdir(),
      excludedTag: options.excludedTag,
      versionsRef: options.versionsRef,
      versionsRepo: options.versionsRepo,
    })
    : capturePublishedVersionHistory({
      auditParent: tmpdir(),
      excludedTag: options.excludedTag,
    });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(errorText(error));
    process.exitCode = 1;
  }
}
