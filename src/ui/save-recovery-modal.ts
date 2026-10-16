import { App, Modal, Notice, Platform, normalizePath } from "obsidian";
import { schema } from "../core/schema";
import { parser } from "../core/parser";
import { preflightButterSave } from "../core/save-policy";
import { nativeFileBytesEqualText } from "../core/native-file-source";
import { fileViewRouting } from "../util/file-view-routing";
import { tx, tv } from "../i18n";
import { SaveRecoveryStore, type SaveRecoverySnapshot } from "../integration/save-recovery";

export type RecoveryProjection =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false };

/** Rehydrate through the current schema and the complete production save policy. */
export function projectRecovery(snapshot: SaveRecoverySnapshot): RecoveryProjection {
  try {
    const doc = schema.nodeFromJSON(snapshot.doc);
    doc.check();
    const originalDoc = parser.parseWithSourceMap(snapshot.policy.originalBody)?.doc ?? null;
    const result = preflightButterSave(doc, { ...snapshot.policy, originalDoc });
    return result.ok ? { ok: true, text: result.text } : { ok: false };
  } catch {
    // Unknown schema/version and malformed snapshots retain their exact JSON.
    return { ok: false };
  }
}

/** A deliberately lossy fallback; never used to create or overwrite a note. */
export function recoveryPlainText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const node = value as { type?: unknown; text?: unknown; attrs?: Record<string, unknown>; content?: unknown[] };
  if (typeof node.text === "string") return node.text;
  const attrs = node.attrs ?? {};
  const stringAttr = (name: string): string => typeof attrs[name] === "string" ? attrs[name] : "";
  if (node.type === "hard_break" || node.type === "softbreak") return "\n";
  if (node.type === "comment_navigation") return stringAttr("source");
  if (node.type === "empty_link") return stringAttr("href");
  if (node.type === "wikilink") return stringAttr("literalSource") ||
    (attrs.emptyAlias === true ? `[[${stringAttr("target")}|]]` : stringAttr("alias") || stringAttr("target"));
  if (node.type === "obsidian_tag") return `#${stringAttr("tag")}`;
  if (node.type === "inline_embed" || node.type === "obsidian_embed" || node.type === "obsidian_embed_inline") return stringAttr("literalSource") || `![[${stringAttr("src")}]]`;
  if (node.type === "image") return [stringAttr("alt"), stringAttr("src")].filter(Boolean).join(" ");
  for (const name of ["raw", "value", "body"]) {
    if (typeof attrs[name] === "string") return attrs[name];
  }
  if (node.type === "inline_footnote") return stringAttr("content");
  if (node.type === "footnote_def") return `[^${stringAttr("label")}]: ${stringAttr("content")}`;
  if (node.type === "block_id" || node.type === "footnote_ref") return stringAttr("id") || stringAttr("label");
  const children = Array.isArray(node.content) ? node.content : [];
  const separator = node.type === "doc" ? "\n\n"
    : node.type === "table" || node.type === "bullet_list" || node.type === "ordered_list" ? "\n"
    : node.type === "table_row" ? "\t" : "";
  const body = children.map(recoveryPlainText).join(separator);
  return node.type === "obsidian_callout" && stringAttr("title")
    ? `${stringAttr("title")}\n${body}` : body;
}

function recoveryBasename(path: string): string {
  const name = path.split(/[\\/]/).pop()?.replace(/\.md$/i, "") ?? "";
  const clean = Array.from(name, character => character.charCodeAt(0) < 32 ? "-" : character).join("");
  return clean.replace(/[<>:"/\\|?*]/g, "-")
    .replace(/[. ]+$/, "").trim().slice(0, 90) || "Note";
}

/** Vault.create is exclusive; collision retries never write an existing file. */
export async function createRecoveryCopy(app: App, snapshot: SaveRecoverySnapshot, text: string): Promise<void> {
  const routing = fileViewRouting(app);
  const folder = "Butter Recovery";
  if (!await app.vault.adapter.exists(folder)) {
    try { await app.vault.createFolder(folder); }
    catch (error) { if (!await app.vault.adapter.exists(folder)) throw error; }
  }
  const date = new Date(snapshot.createdAt).toISOString().replace(/[:.]/g, "-");
  const base = `${recoveryBasename(snapshot.notePath)} - recovered ${date}`;
  for (let index = 0; index < 100; index++) {
    const path = normalizePath(`${folder}/${base}${index ? ` ${index + 1}` : ""}.md`);
    if (await app.vault.adapter.exists(path)) continue;
    let file;
    try { file = await app.vault.create(path, text); }
    catch (error) {
      if (await app.vault.adapter.exists(path)) continue;
      throw error;
    }
    // A resolved create is not an acknowledgement of exact stored bytes.
    // Leave an unconfirmed new file inspectable and keep the checkpoint; do
    // not open it or announce verified recovery until native readback agrees.
    if (file.path !== path || app.vault.getAbstractFileByPath(path) !== file) {
      throw new Error("Recovery copy file ownership changed before readback");
    }
    const bytes = await app.vault.readBinary(file);
    // Vault.read can remove a UTF-8 BOM. A text projection cannot acknowledge
    // physical bytes, and an awaited read cannot preserve occurrence identity.
    if (file.path !== path || app.vault.getAbstractFileByPath(path) !== file ||
      !nativeFileBytesEqualText(bytes, text)) {
      throw new Error("Recovery copy did not confirm the verified file bytes");
    }
    // Keep the snapshot until the user explicitly discards it or its original
    // editor generation is acknowledged. Creating a copy does not retire it.
    // openFile resolves the extension's registered view, which can be Butter.
    // Use the explicit native type, as the normal source-mode switch does.
    if (routing.isDisposed) throw new Error("Recovery view routing is no longer active");
    const leaf = app.workspace.getLeaf(true);
    const owner = routing.capture(leaf, file);
    if (!owner || !await routing.setExplicit(owner, {
      type: "markdown",
      active: true,
      state: { file: path, mode: "source", source: true },
    })) throw new Error("Recovery copy did not open in the native source view");
    return;
  }
  throw new Error("Could not find an unused recovery copy name");
}

export class SaveRecoveryModal extends Modal {
  private closed = false;
  private renderGeneration = 0;

  constructor(app: App, private readonly store: SaveRecoveryStore,
    private readonly onDiscarded?: (snapshot: SaveRecoverySnapshot) => void) { super(app); }

  onOpen(): void {
    this.closed = false;
    if (Platform.isMobile) this.modalEl.addClass("mod-lg");
    this.titleEl.setText(tx("Recover unsaved edits"));
    void this.render();
  }

  private async render(): Promise<void> {
    const generation = ++this.renderGeneration;
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: tx("Recovery actions leave your original notes unchanged. Snapshots remain until saved or discarded.") });
    this.contentEl.createEl("p", {
      cls: "setting-item-description",
      text: tx("Snapshots contain note content and are stored with this plugin in your vault configuration. Your sync setup may sync them."),
    });
    const list = this.contentEl.createDiv();
    list.setAttribute("aria-live", "polite");
    list.createEl("p", { text: tx("Loading recovery snapshots...") });
    try {
      const snapshots = await this.store.list();
      if (this.closed || generation !== this.renderGeneration) return;
      list.empty();
      if (this.store.unreadableSlotCount > 0) list.createEl("p", {
        text: tx("Some recovery snapshots could not be read. Available copies are shown; unreadable snapshots were kept. Try Refresh before discarding anything."),
      });
      if (!snapshots.length) list.createEl("p", { text: tx("No retained snapshots are available.") });
      for (const snapshot of snapshots) this.renderSnapshot(list, snapshot);
    } catch {
      if (this.closed || generation !== this.renderGeneration) return;
      list.empty();
      list.createEl("p", { text: tx("Could not read recovery snapshots. Try again; your original notes are unchanged.") });
    }
    if (this.closed || generation !== this.renderGeneration) return;
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    this.button(buttons, tx("Refresh"), () => this.render());
    this.button(buttons, tx("Close"), () => { this.close(); });
  }

  private renderSnapshot(list: HTMLElement, snapshot: SaveRecoverySnapshot): void {
    const row = list.createDiv({ cls: "setting-item" });
    const info = row.createDiv({ cls: "setting-item-info" });
    info.createEl("h4", { text: snapshot.notePath });
    info.createEl("p", { text: tv("Retained: {time}", { time: new Date(snapshot.createdAt).toLocaleString() }) });
    const projection = projectRecovery(snapshot);
    info.createEl("p", {
      text: projection.ok
        ? tx("This snapshot can be opened as a verified Markdown copy.")
        : tx("This snapshot cannot yet be saved faithfully. Copy its text or exact JSON instead."),
    });
    const actions = info.createDiv({ cls: "modal-button-container" });
    if (projection.ok) {
      this.button(actions, tx("Open recovered copy"), async () => {
        // Reverify on the explicit action; never use an unverified serialization.
        const current = projectRecovery(snapshot);
        if (!current.ok) throw new Error("Recovery no longer passes exact save validation");
        await createRecoveryCopy(this.app, snapshot, current.text);
        new Notice(tx("Opened a recovery copy. The original note and snapshot are unchanged."));
      });
    } else {
      info.createEl("p", {
        cls: "setting-item-description",
        text: tx("Plain text omits formatting and may omit unsupported elements. Keep the exact JSON snapshot for complete recovery."),
      });
      const plain = info.createEl("textarea");
      plain.value = recoveryPlainText(snapshot.doc);
      plain.readOnly = true;
      plain.rows = 4;
      plain.setAttribute("aria-label", tx("Recovered plain text"));
      this.button(actions, tx("Copy plain text"), () => this.copy(plain.value));
    }
    const details = info.createEl("details");
    details.createEl("summary", { text: tx("Exact snapshot JSON") });
    const json = details.createEl("textarea");
    json.value = JSON.stringify(snapshot, null, 2);
    json.readOnly = true;
    json.rows = 8;
    json.setAttribute("aria-label", tx("Exact snapshot JSON"));
    details.createEl("p", {
      cls: "setting-item-description",
      text: tx("This JSON contains your note content. Share it only if you choose to."),
    });
    this.button(actions, tx("Copy snapshot JSON"), () => this.copy(json.value));
    this.button(actions, tx("Discard snapshot"), async () => {
      if (await this.store.discardDisplayed(snapshot)) this.onDiscarded?.(snapshot);
      await this.render();
    }, true);
  }

  private async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      new Notice(tx("Copied to clipboard."));
    } catch {
      new Notice(tx("Could not copy automatically. Select and copy the text shown in this dialog."), 8000);
    }
  }

  private button(parent: HTMLElement, label: string, action: () => void | Promise<void>, warning = false): void {
    const button = parent.createEl("button", { text: label, cls: warning ? "mod-warning" : "" });
    button.type = "button";
    button.addEventListener("click", () => {
      if (button.disabled) return;
      button.disabled = true;
      void Promise.resolve().then(action).catch(() => {
        new Notice(tx("Could not complete this recovery action. Your original note is unchanged."), 10000);
      }).finally(() => { button.disabled = false; });
    });
  }

  onClose(): void {
    this.closed = true;
    this.renderGeneration++;
    this.contentEl.empty();
  }
}
