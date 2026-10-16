import { Notice, type App, type TFile } from "obsidian";
import { canEncodeButterFileUtf8 } from "../core/file-shell";
import { nativeFileBytesEqualText } from "../core/native-file-source";
import { tx } from "../i18n";
import { recordError } from "../integration/debug";
import { fileViewRouting, type FileViewRouting } from "../util/file-view-routing";

/** The created occurrence, never authority to delete a later native change. */
export interface OwnedAttachment {
  readonly file: TFile;
  readonly createdPath: string;
  readonly sourcePath: string;
  readonly routing: FileViewRouting;
}

export function captureAttachmentOperation(app: App): FileViewRouting {
  return fileViewRouting(app);
}

export async function saveOwnedAttachment(
  app: App,
  blob: Blob,
  preferredName: string,
  sourcePath: string,
  preserveExactName = false,
  routing: FileViewRouting = captureAttachmentOperation(app),
): Promise<OwnedAttachment | null> {
  // Capture this activation before native IO. A late notice must not recreate
  // a disposed router or borrow a newly loaded editor's authority.
  if (routing.isDisposed) return null;
  const nameParts = preferredName.split(/[\\/]/);
  const cleanName = nameParts[nameParts.length - 1]?.trim() || "attachment";
  const ext = blob.type.split("/")[1]?.split("+")[0] || "bin";
  const filename = preserveExactName ? cleanName : `${cleanName}.${ext}`;
  // Native FileManager owns folder policy, parent creation and collisions.
  const path = await app.fileManager.getAvailablePathForAttachment(filename, sourcePath);
  if (routing.isDisposed) return null;
  const bytes = await blob.arrayBuffer();
  if (routing.isDisposed) return null;
  const file = await app.vault.createBinary(path, bytes);
  if (!file) return null;
  return { file, createdPath: path, sourcePath, routing };
}

export function attachmentStillPresent(app: App, attachment: OwnedAttachment): boolean {
  return app.vault.getAbstractFileByPath(attachment.file.path) === attachment.file;
}

const reportedAttachments = new WeakSet<OwnedAttachment>();
let recoverySequence = 0;

/** JSON escapes control characters; a longer code fence keeps path text inert. */
function literalPath(path: string): string {
  const text = JSON.stringify(path);
  let length = 1;
  for (const run of text.match(/`+/g) ?? []) length = Math.max(length, run.length + 1);
  const fence = "`".repeat(length);
  return `${fence} ${text} ${fence}`;
}

interface AttachmentIndex {
  readonly file: TFile;
  readonly path: string;
  readonly text: string;
}

/** Separate native note; never an unsaved-document snapshot or a binary backup. */
export async function createRetainedAttachmentIndex(
  app: App, attachments: readonly OwnedAttachment[],
): Promise<AttachmentIndex> {
  const folder = "Butter Recovery";
  if (!await app.vault.adapter.exists(folder)) {
    try { await app.vault.createFolder(folder); }
    catch (error) { if (!await app.vault.adapter.exists(folder)) throw error; }
  }
  const date = new Date().toISOString().replace(/[:.]/g, "-");
  for (let attempt = 0; attempt < 100; attempt++) {
    const path = `${folder}/Attachments retained ${date}-${++recoverySequence}.md`;
    if (await app.vault.adapter.exists(path)) continue;
    const lines = [
      `# ${tx("Attachments kept after an interrupted insertion")}`, "",
      tx("Butter could not insert these attachments. Review the saved files before trying again."), "",
      tx("Use Obsidian's file menu to remove unwanted attachments. Your deletion preference applies."), "",
    ];
    let unavailable = false;
    for (const attachment of attachments) {
      // A same-path replacement is not the created attachment. Record only a
      // historical path for it; never offer a link to the foreign occurrence.
      const present = attachmentStillPresent(app, attachment);
      const currentPath = present ? attachment.file.path : attachment.createdPath;
      lines.push(`${tx("Original note path")}: ${literalPath(attachment.sourcePath)}`, "",
        `- ${literalPath(currentPath)}`);
      if (present && canEncodeButterFileUtf8(currentPath)) {
        // This fixed, single-level folder makes every link vault-relative.
        // Encode all path segments: filenames cannot inject Markdown or HTML.
        const href = `../${currentPath.split("/").map(part => encodeURIComponent(part)
          .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join("/")}`;
        lines.push(`  [${tx("Open attachment")}](${href})`);
      } else unavailable = true;
      lines.push("");
    }
    if (unavailable) lines.push(tx("Some files have moved or are no longer at their recorded paths."), "");
    const text = lines.join("\n");
    if (!canEncodeButterFileUtf8(text)) throw new Error("Attachment index cannot be encoded faithfully");
    // Vault.create is exclusive. A failed create may have partially written;
    // retain that result too, rather than retrying or removing unknown bytes.
    const file = await app.vault.create(path, text);
    if (file.path !== path || app.vault.getAbstractFileByPath(path) !== file) {
      throw new Error("Attachment index occurrence was not verified");
    }
    const bytes = await app.vault.readBinary(file);
    if (file.path !== path || app.vault.getAbstractFileByPath(path) !== file ||
      !nativeFileBytesEqualText(bytes, text)) throw new Error("Attachment index readback was not verified");
    return { file, path, text };
  }
  throw new Error("Could not find an unused attachment index path");
}

export async function retainUninsertedAttachments(
  app: App,
  attachments: readonly OwnedAttachment[],
  category: "paste" | "drop",
): Promise<void> {
  const retained = attachments.filter(attachment => !reportedAttachments.has(attachment));
  if (!retained.length) return;
  for (const attachment of retained) reportedAttachments.add(attachment);
  const routing = retained[0].routing;
  // FileManager.trashFile honors "none" by permanently deleting. There is no
  // public compare-and-delete API: checking or copying bytes before deletion
  // cannot protect a later native update. Leave attachments in place; explicit
  // cleanup belongs to Obsidian's normal file UI and its deletion preference.
  let index: AttachmentIndex;
  try { index = await createRetainedAttachmentIndex(app, retained); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordError(category, `Attachment recovery index failed; saved files were retained: ${message}`);
    if (!routing.isDisposed) {
      try { new Notice(`${tx("Could not create an attachment recovery note. Review these paths in your vault:")}\n${
        retained.map(attachment => JSON.stringify(attachmentStillPresent(app, attachment) ? attachment.file.path : attachment.createdPath)).join("\n")}`, 0); }
      catch { recordError(category, "Attachment recovery fallback notice failed; saved files were retained"); }
    }
    return;
  }
  if (routing.isDisposed) return;
  try {
    const fragment = createFragment();
    const message = createEl("p");
    message.textContent = tx("Butter could not insert these attachments. Review the saved files before trying again.");
    fragment.appendChild(message);
    const path = createEl("code");
    path.textContent = index.path;
    fragment.appendChild(path);
    const button = createEl("button");
    button.type = "button";
    button.textContent = tx("Open retained attachments");
    fragment.appendChild(button);
    const notice = new Notice(fragment, 0);
    button.addEventListener("click", () => {
      if (button.disabled) return;
      if (routing.isDisposed) { button.disabled = true; notice.hide(); return; }
      button.disabled = true;
      void (async () => {
        const bytes = await app.vault.readBinary(index.file);
        if (routing.isDisposed) return;
        if (index.file.path !== index.path ||
          app.vault.getAbstractFileByPath(index.path) !== index.file ||
          !nativeFileBytesEqualText(bytes, index.text)) throw new Error("Retained attachment note changed before opening");
        const leaf = app.workspace.getLeaf(true), owner = routing.capture(leaf, index.file);
        if (!owner || !await routing.setExplicit(owner, {
          type: "markdown", active: true, state: { file: index.path, mode: "preview" },
        })) throw new Error("Retained attachment note could not open in native Markdown");
        notice.hide();
      })().catch(() => {
        if (!routing.isDisposed) {
          try { new Notice(tx("Could not open the retained attachment note.")); }
          catch { recordError(category, "Retained attachment opening notice failed"); }
        }
      }).finally(() => { button.disabled = false; });
    });
  } catch (error) {
    recordError(category, `Attachment recovery notice failed: ${String(error)}`);
    // The verified native index remains discoverable after restart even when
    // native notice rendering fails. No attachment or note is ever removed.
  }
}
