import { TFile, type App, type View, type ViewState, type Workspace, type WorkspaceLeaf } from "obsidian";

interface WorkspaceFactoryReferences {
  readonly getLeaf: (this: Workspace, ...args: Parameters<Workspace["getLeaf"]>) => WorkspaceLeaf;
  readonly createLeafInParent: (this: Workspace, ...args: Parameters<Workspace["createLeafInParent"]>) => WorkspaceLeaf;
  readonly createLeafBySplit: (this: Workspace, ...args: Parameters<Workspace["createLeafBySplit"]>) => WorkspaceLeaf;
  readonly openPopoutLeaf: (this: Workspace, ...args: Parameters<Workspace["openPopoutLeaf"]>) => WorkspaceLeaf;
}

type LeafSetter = (this: WorkspaceLeaf, ...args: Parameters<WorkspaceLeaf["setViewState"]>) => Promise<void>;

interface LeafSetterReference {
  readonly setViewState: LeafSetter;
}

interface LeafSnapshot {
  readonly view: View;
  readonly file: TFile | null;
  readonly path: string | null;
  readonly type: string;
  readonly mode: unknown;
  readonly source: unknown;
}

export interface FileViewOwner {
  readonly leaf: WorkspaceLeaf;
  readonly file: TFile;
  readonly path: string;
  readonly generation: number;
  readonly snapshot: LeafSnapshot;
}

interface RouteRequest {
  readonly owner: FileViewOwner;
  readonly state: ViewState;
  readonly desired: { readonly type: string; readonly file: string; readonly mode: string | undefined;
    readonly source: boolean | undefined };
  readonly predecessor: RouteRequest | null;
  readonly generation: number;
  readonly explicit: boolean;
  readonly external: boolean;
  result: LeafSnapshot | null;
  started: boolean;
}

interface LeafRouting {
  generation: number;
  observedSetter: boolean;
  observed: LeafSnapshot;
  intent: RouteRequest | null;
  pending: RouteRequest | null;
  active: RouteRequest | null;
  dispatching: RouteRequest | null;
  tail: Promise<boolean> | null;
  readonly original: LeafSetter;
  readonly wrapper: LeafSetter;
  readonly descriptor: PropertyDescriptor | undefined;
}

function snapshot(leaf: WorkspaceLeaf): LeafSnapshot {
  const state = leaf.getViewState().state as { mode?: unknown; source?: unknown } | undefined;
  const view = leaf.view;
  const file = (view as View & { file?: TFile | null }).file ?? null;
  return { view, file, path: file?.path ?? null, type: view.getViewType(),
    mode: state?.mode, source: state?.source };
}

function sameSnapshot(a: LeafSnapshot, b: LeafSnapshot): boolean {
  return a.view === b.view && a.file === b.file && a.path === b.path &&
    a.type === b.type && a.mode === b.mode && a.source === b.source;
}

/** Own only view routing, never note content. Native setters may resolve without
 * applying their state, so every successful route requires a resulting-view ack. */
export class FileViewRouting {
  private readonly leaves = new Map<WorkspaceLeaf, LeafRouting>();
  private readonly owners = new WeakSet<FileViewOwner>();
  private readonly factoryRestorers: Array<() => void> = [];
  private observingWorkspace = false;
  private disposed = false;

  constructor(private readonly app: App) {}

  /** Native leaf factories return before their delayed layout/file events.
   * Observe that synchronous return so the first explicit setter is owned too. */
  observeWorkspaceLeaves(): void {
    if (this.disposed) return;
    if (!this.observingWorkspace) {
      this.observingWorkspace = true;
      const workspace = this.app.workspace;
      // Capture native function values with their caller-supplied receivers.
      const factories: WorkspaceFactoryReferences = workspace;
      this.observeFactory("getLeaf", factories.getLeaf);
      this.observeFactory("createLeafInParent", factories.createLeafInParent);
      this.observeFactory("createLeafBySplit", factories.createLeafBySplit);
      // Observe calls made by legacy native consumers; we never initiate a
      // deprecated getUnpinnedLeaf operation ourselves.
      const legacyFactory: unknown = Reflect.get(workspace, "getUnpinnedLeaf");
      if (typeof legacyFactory === "function") this.observeFactory("getUnpinnedLeaf",
        legacyFactory as (this: Workspace, ...args: unknown[]) => WorkspaceLeaf);
      this.observeFactory("openPopoutLeaf", factories.openPopoutLeaf);
    }
    this.sweepDetached();
  }

  private observeFactory<Args extends unknown[]>(name: keyof Workspace,
    original: (this: Workspace, ...args: Args) => WorkspaceLeaf): void {
    if (typeof original !== "function") return;
    const workspace = this.app.workspace, descriptor = Object.getOwnPropertyDescriptor(workspace, name);
    const observe = (receiver: Workspace, result: WorkspaceLeaf): void => {
      if (receiver === workspace && !this.disposed) {
        // Observation is optional; malformed/early native returns or locked
        // descriptors must never change the native factory's result/error.
        try { this.observeReturnedLeaf(result); } catch { /* Keep native return semantics. */ }
      }
    };
    const wrapper = function(this: Workspace, ...args: Args): WorkspaceLeaf {
      const result = original.apply(this, args);
      observe(this, result);
      return result;
    };
    try { Object.defineProperty(workspace, name, {
      value: wrapper, configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false,
    }); } catch { return; }
    this.factoryRestorers.push(() => {
      if (workspace[name] !== wrapper) return;
      if (descriptor) Object.defineProperty(workspace, name, descriptor);
      else Reflect.deleteProperty(workspace, name);
    });
  }

  private observeReturnedLeaf(value: unknown): void {
    if (this.disposed) return;
    let attachedLeaf: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves(leaf => { if (leaf === value) attachedLeaf = leaf; });
    if (attachedLeaf) this.track(attachedLeaf);
  }

  private attached(leaf: WorkspaceLeaf): boolean {
    let found = false;
    this.app.workspace.iterateAllLeaves(current => { if (current === leaf) found = true; });
    return found;
  }

  private track(leaf: WorkspaceLeaf): LeafRouting | null {
    const previous = this.leaves.get(leaf);
    if (previous) return leaf.setViewState === previous.wrapper ? previous : null;
    if (typeof leaf.setViewState !== "function" || typeof leaf.getViewState !== "function" ||
      typeof leaf.view?.getViewType !== "function") return null;
    const setter: LeafSetterReference = leaf;
    const original = setter.setViewState, descriptor = Object.getOwnPropertyDescriptor(leaf, "setViewState");
    const observeSetter = (receiver: WorkspaceLeaf, args: Parameters<WorkspaceLeaf["setViewState"]>): void => {
      if (receiver === leaf) state.observedSetter = true;
      if (receiver === leaf && state.dispatching?.state !== args[0]) {
        state.generation++;
        state.intent = null;
        const wanted = args[0].state as { file?: unknown; mode?: unknown; source?: unknown } | undefined;
        // Qualified native openFile supplies only file by default. Native
        // mode switches instead supply their explicitly requested mode/source.
        const file = typeof wanted?.file === "string" ? this.app.vault.getAbstractFileByPath(wanted.file) : null;
        if (!this.disposed && args[0].type === "markdown" && file instanceof TFile &&
          (wanted?.mode === "source" || wanted?.mode === "preview" || typeof wanted?.source === "boolean")) {
          const owner = { leaf, file, path: file.path, generation: state.generation, snapshot: snapshot(leaf) };
          this.owners.add(owner);
          state.intent = { owner, state: args[0], desired: { type: "markdown", file: file.path,
            mode: typeof wanted.mode === "string" ? wanted.mode : undefined,
            source: typeof wanted.source === "boolean" ? wanted.source : undefined },
            predecessor: null, generation: state.generation, explicit: true, external: true,
            result: null, started: true };
        }
      }
    };
    const observeCompletion = (intent: RouteRequest, completion: Promise<void>): void => {
      void completion.then(() => {
        if (this.disposed || state.intent !== intent || state.generation !== intent.generation) return;
        intent.result = this.acknowledged(intent);
        if (!intent.result) state.intent = null;
        state.observed = snapshot(leaf);
      }, () => { if (state.intent === intent) state.intent = null; }).catch(() => {
        if (state.intent === intent) state.intent = null;
      });
    };
    const state: LeafRouting = { generation: 0, observedSetter: false, observed: snapshot(leaf), intent: null,
      pending: null, active: null, dispatching: null, tail: null, original, descriptor,
      wrapper: function(this: WorkspaceLeaf, ...args: Parameters<WorkspaceLeaf["setViewState"]>) {
        // Observe only this exact leaf. Preserve native receiver and arguments,
        // including calls made by other plugins after this observer is installed.
        observeSetter(this, args);
        const intent = state.intent;
        let completion: Promise<void>;
        try { completion = original.apply(this, args); }
        catch (error) { if (state.intent === intent && intent?.external) state.intent = null; throw error; }
        if (this === leaf && intent?.external && intent.state === args[0]) {
          observeCompletion(intent, completion);
        }
        return completion;
      } };
    try { Object.defineProperty(leaf, "setViewState", {
      value: state.wrapper, configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false,
    }); } catch { return null; }
    this.leaves.set(leaf, state);
    return state;
  }

  capture(leaf: WorkspaceLeaf, file: TFile): FileViewOwner | null {
    if (this.disposed || !this.attached(leaf) ||
      this.app.vault.getAbstractFileByPath(file.path) !== file) return null;
    const state = this.track(leaf), current = snapshot(leaf);
    if (!state) return null;
    const owner = { leaf, file, path: file.path, generation: state.generation, snapshot: current };
    this.owners.add(owner);
    return owner;
  }

  /** A late file event cannot grant default routing authority to a pane whose
   * first setter was not observed. Explicit callers can still capture it. */
  captureAutomatic(leaf: WorkspaceLeaf, file: TFile): FileViewOwner | null {
    return this.leaves.get(leaf)?.observedSetter ? this.capture(leaf, file) : null;
  }

  isCurrent(owner: FileViewOwner): boolean {
    const state = this.leaves.get(owner.leaf);
    return !this.disposed && this.owners.has(owner) && Boolean(state) && owner.leaf.setViewState === state?.wrapper && state?.generation === owner.generation &&
      owner.file.path === owner.path && this.app.vault.getAbstractFileByPath(owner.path) === owner.file &&
      this.attached(owner.leaf) && sameSnapshot(snapshot(owner.leaf), owner.snapshot);
  }

  /** A delayed mount may replace the view after file-open, but may not borrow
   * a navigation generation acquired by a later public route or file event. */
  automaticOwner(owner: FileViewOwner): FileViewOwner | null {
    const state = this.leaves.get(owner.leaf);
    if (this.disposed || !this.owners.has(owner) || !state || owner.leaf.setViewState !== state.wrapper || state.generation !== owner.generation ||
      owner.file.path !== owner.path || this.app.vault.getAbstractFileByPath(owner.path) !== owner.file ||
      !this.attached(owner.leaf)) return null;
    const current = snapshot(owner.leaf);
    if (current.file !== owner.file) return null;
    const currentOwner = { ...owner, snapshot: current };
    this.owners.add(currentOwner);
    return currentOwner;
  }

  private acknowledged(request: RouteRequest): LeafSnapshot | null {
    const { owner, desired } = request;
    if (owner.file.path !== owner.path || this.app.vault.getAbstractFileByPath(owner.path) !== owner.file ||
      !this.attached(owner.leaf)) return null;
    const current = snapshot(owner.leaf);
    if (current.file !== owner.file || current.path !== owner.path || current.type !== desired.type ||
      desired.file !== owner.path || (desired.mode !== undefined && current.mode !== desired.mode) ||
      (desired.source !== undefined && current.source !== desired.source)) return null;
    return current;
  }

  hasExplicitIntent(leaf: WorkspaceLeaf, file: TFile): boolean {
    const state = this.leaves.get(leaf), intent = state?.intent;
    if (!state || !intent || this.disposed || intent.owner.file !== file ||
      this.app.vault.getAbstractFileByPath(file.path) !== file) return false;
    if (!intent.result) return intent.owner.path === file.path && state.generation === intent.generation;
    // A settled native mode follows an ordinary rename on this exact view and
    // TFile. Captured pending requests still use their immutable original path.
    const current = snapshot(leaf), wanted = intent.desired;
    return current.view === intent.result.view && current.file === file && current.type === wanted.type &&
      (wanted.mode === undefined || current.mode === wanted.mode) &&
      (wanted.source === undefined || current.source === wanted.source);
  }

  /** File-open can reuse a native view without calling the leaf setter. Observe
   * those changes as well; do not mistake our own mount event for new intent. */
  observeFileOpen(file: TFile | null): void {
    for (const [leaf, state] of this.leaves) {
      if (!this.attached(leaf)) { this.restore(leaf, state); this.leaves.delete(leaf); continue; }
      const current = snapshot(leaf), own = state.active ?? (state.intent?.external && !state.intent.result ? state.intent : null);
      const ownEvent = own && state.generation === own.generation &&
        ((file === own.owner.file && file.path === own.owner.path) ||
          // A qualified native mount can publish its new, targetless view
          // before loading the file. Keep only this exact pending generation
          // and requested type; another public setter still invalidates it.
          (file === null && current.file === null && current.type === own.desired.type));
      if (!ownEvent && !sameSnapshot(current, state.observed)) {
        state.generation++;
        // Rename may retain a completed explicit native view, but no old
        // queued request acquires the new path through this observation.
        if (!state.intent?.result || state.intent.result.view !== current.view ||
          state.intent.owner.file !== current.file) state.intent = null;
      }
      state.observed = current;
    }
  }

  sweepDetached(): void {
    for (const [leaf, state] of this.leaves) {
      if (!this.attached(leaf)) { this.restore(leaf, state); this.leaves.delete(leaf); }
    }
    if (this.observingWorkspace && !this.disposed) {
      this.app.workspace.iterateAllLeaves(leaf => {
        try { this.track(leaf); } catch { /* An early mount may not expose its view yet. */ }
      });
    }
  }

  setExplicit(owner: FileViewOwner, viewState: ViewState,
    ephemeralState?: Record<string, unknown>): Promise<boolean> {
    return this.route(owner, viewState, true, ephemeralState);
  }

  setAutomatic(owner: FileViewOwner, viewState: ViewState): Promise<boolean> {
    return this.route(owner, viewState, false);
  }

  private route(owner: FileViewOwner, viewState: ViewState, explicit: boolean,
    ephemeralState?: Record<string, unknown>): Promise<boolean> {
    const state = this.leaves.get(owner.leaf);
    if (!state || !this.isCurrent(owner)) return Promise.resolve(false);
    const wanted = viewState.state;
    if (wanted?.file !== owner.path || (wanted.mode !== undefined && typeof wanted.mode !== "string") ||
      (wanted.source !== undefined && typeof wanted.source !== "boolean")) return Promise.resolve(false);
    const predecessor = state.pending;
    // Explicit intent is recorded synchronously, before native file-open hooks
    // can run. An already-started automatic route is allowed to finish first.
    const request: RouteRequest = { owner, state: { ...viewState, state: { ...wanted } }, predecessor,
      desired: { type: viewState.type, file: owner.path, mode: wanted.mode,
        source: wanted.source },
      generation: state.generation, explicit, external: false, result: null, started: false };
    if (explicit) state.intent = request;
    const previous = state.tail;
    state.pending = request;
    const run = async (): Promise<boolean> => {
      if (previous) await previous;
      const current = snapshot(owner.leaf);
      const ownPredecessor = predecessor?.result && sameSnapshot(current, predecessor.result);
      if (this.disposed || owner.leaf.setViewState !== state.wrapper || state.generation !== request.generation ||
        owner.file.path !== owner.path || this.app.vault.getAbstractFileByPath(owner.path) !== owner.file ||
        !this.attached(owner.leaf) || (!sameSnapshot(current, owner.snapshot) && !ownPredecessor) ||
        (explicit ? state.intent !== request : this.hasExplicitIntent(owner.leaf, owner.file))) return false;
      request.started = true;
      state.active = request;
      // A same-mode explicit action still records intent but need not remount.
      if (!this.acknowledged(request)) {
        state.dispatching = request;
        let completion: Promise<void>;
        try { completion = owner.leaf.setViewState(request.state, ephemeralState); }
        finally { state.dispatching = null; }
        await completion;
      }
      if (this.disposed || owner.leaf.setViewState !== state.wrapper || state.generation !== request.generation) return false;
      request.result = this.acknowledged(request);
      state.observed = snapshot(owner.leaf);
      return request.result !== null;
    };
    const completion = run().catch(() => false).then(applied => {
      if (state.active === request) state.active = null;
      if (state.pending === request) { state.pending = null; state.tail = null; }
      if (!applied && state.intent === request) state.intent = null;
      return applied;
    });
    state.tail = completion;
    return completion;
  }

  private restore(leaf: WorkspaceLeaf, state: LeafRouting): void {
    state.generation++;
    state.intent = null;
    if (leaf.setViewState !== state.wrapper) return;
    // A consumer may lock our wrapper in place after installation. Invalidate
    // its authority but preserve that foreign descriptor and other cleanup.
    try {
      if (state.descriptor) Object.defineProperty(leaf, "setViewState", state.descriptor);
      else Reflect.deleteProperty(leaf, "setViewState");
    } catch { /* The locked wrapper still delegates native calls without live routing authority. */ }
  }

  dispose(): void {
    this.disposed = true;
    for (const restore of this.factoryRestorers.splice(0).reverse()) {
      try { restore(); } catch { /* A foreign locked descriptor remains untouched. */ }
    }
    for (const [leaf, state] of this.leaves) this.restore(leaf, state);
    this.leaves.clear();
  }

  get isDisposed(): boolean { return this.disposed; }
}

const routers = new WeakMap<App, FileViewRouting>();
export function fileViewRouting(app: App): FileViewRouting {
  let routing = routers.get(app);
  if (!routing || routing.isDisposed) { routing = new FileViewRouting(app); routers.set(app, routing); }
  return routing;
}
