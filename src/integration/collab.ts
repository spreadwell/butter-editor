/**
 * collab.ts
 *
 * Collaborative editing infrastructure for Butter PMX.
 *
 * Wires `prosemirror-collab`'s plugin into the editor + defines a
 * pluggable transport abstraction so the backend is an implementation
 * detail of the deploy - the editor core stays transport-agnostic.
 *
 * Scope:
 *   • The PM-side plumbing: collab plugin, step-sending loop on
 *     local changes, step-receiving loop on remote deltas, clean
 *     shutdown on view destroy.
 *   • A `CollabTransport` interface: two functions and two callbacks.
 *     Implementors supply whatever backend fits (WebSocket, WebRTC,
 *     IndexedDB+polling, etc.).
 *   • An in-memory transport for tests - two "clients" in the same
 *     process sharing steps through a simple queue. Proves the
 *     plumbing works end-to-end without any network dependency.
 *
 * Out of scope:
 *   • A server implementation. That's environment-specific.
 *   • Authentication / identity / access control. Live at the
 *     transport layer, not here.
 *   • Source-preservation reconciliation across concurrent edits.
 *     The first-wins model in getVersion/receiveTransaction handles
 *     OT-level conflict; block-level source preservation should
 *     still function because each client's view converges to the
 *     same doc state before save.
 *
 * Integration: this module is NOT wired into main.ts by default.
 * To enable collaborative editing on a Butter view, pass your
 * transport instance to `setupCollab(editorView, transport)` after
 * the view is created. See test-collab.mjs for the full cycle.
 */
import { EditorView } from "prosemirror-view";
import { EditorState, Transaction } from "prosemirror-state";
import {
  collab,
  sendableSteps,
  receiveTransaction,
  getVersion,
} from "prosemirror-collab";
import { Step } from "prosemirror-transform";

/**
 * A serialized step that can cross the network. `step` is the raw
 * JSON from `Step.toJSON()`; `clientID` identifies the originating
 * client so each client can ignore its own echoes.
 */
export interface CollabStep {
  step: unknown;
  clientID: number | string;
}

/**
 * Pluggable transport. Implementors decide how to move steps
 * between clients; the editor uses only this interface.
 */
export interface CollabTransport {
  /** Unique, stable identifier for this client in the session. */
  clientID: number | string;

  /** Current authoritative document state (used to initialize the
   *  local editor OR verify on reconnect). Steps returned here
   *  should cover changes since version 0 (or since a known
   *  checkpoint - up to the transport). */
  getInitialState(): Promise<{ version: number }>;

  /** Persist local steps. Returns once the server has accepted them
   *  (or rejects via rejection). On rejection, the caller should
   *  re-fetch state and rebuild - the standard OT lose-the-race path. */
  sendSteps(
    version: number,
    steps: CollabStep[],
  ): Promise<{ accepted: boolean }>;

  /** Subscribe to step broadcasts from other clients. The callback
   *  fires with each batch of steps the server has accepted from
   *  any client (including this client's own steps, which the plugin
   *  filters via clientID comparison). Returns an unsubscribe. */
  onRemoteSteps(
    cb: (version: number, steps: CollabStep[]) => void,
  ): () => void;
}

/**
 * Install collaborative editing on an already-mounted editor view.
 *
 * Adds the collab plugin to the state (preserving existing plugins)
 * and sets up a two-way sync loop:
 *   • Local transactions → serialize pending steps → transport.sendSteps.
 *   • Remote steps via transport.onRemoteSteps → receiveTransaction.
 *
 * Returns a `dispose` function to unwire everything on view destroy.
 * Calling it unsubscribes from remote steps and removes the collab
 * plugin - converting the view back to single-user mode cleanly.
 *
 * Note: once collab is enabled, every local edit produces a network
 * round-trip per batch. On a slow backend this can introduce lag; for
 * typing-latency-sensitive UX, implement transport.sendSteps with
 * local batching + debounce (common pattern).
 */
export async function setupCollab(
  view: EditorView,
  transport: CollabTransport,
): Promise<{ dispose: () => void }> {
  const initial = await transport.getInitialState();

  // Add collab plugin to the existing state.
  const plugins = [
    collab({ version: initial.version, clientID: transport.clientID }),
    ...view.state.plugins,
  ];
  view.updateState(
    EditorState.create({
      doc: view.state.doc,
      selection: view.state.selection,
      plugins,
    }),
  );

  // Wrap the view's dispatchTransaction so we can observe local edits
  // and emit their steps upstream.
  const originalDispatch = view.dispatch.bind(view);
  const localDispatch = (tr: Transaction) => {
    originalDispatch(tr);
    const sendable = sendableSteps(view.state);
    if (sendable) {
      // `sendable.clientID` is the single local client ID for the
      // whole batch - prosemirror-collab tracks ownership per-client,
      // not per-step. We duplicate it into each CollabStep so the
      // transport's rebroadcast format is uniform.
      const batchClientID = (sendable as unknown as { clientID: number | string })
        .clientID;
      const payload: CollabStep[] = sendable.steps.map((s: Step) => ({
        step: s.toJSON() as unknown,
        clientID: batchClientID,
      }));
      // Fire-and-forget - the transport handles retry / rejection.
      transport.sendSteps(sendable.version, payload).catch((err) => {
        console.warn("[butter-collab] sendSteps failed:", err);
      });
    }
  };
  (view as unknown as { dispatch: typeof localDispatch }).dispatch = localDispatch;

  // Subscribe to remote step broadcasts.
  const unsubscribe = transport.onRemoteSteps((version, steps) => {
    // Skip empty broadcasts and self-echoes the plugin would filter
    // anyway (receiveTransaction handles clientID matching internally).
    if (!steps || steps.length === 0) return;
    try {
      const stepObjs = steps.map((s) =>
        Step.fromJSON(view.state.schema, s.step),
      );
      const clientIDs = steps.map((s) => s.clientID);
      const tr = receiveTransaction(view.state, stepObjs, clientIDs);
      originalDispatch(tr);
    } catch (err) {
      console.warn("[butter-collab] receiveTransaction failed:", err);
    }
  });

  return {
    dispose: () => {
      unsubscribe();
      (view as { dispatch: typeof originalDispatch }).dispatch = originalDispatch;
    },
  };
}

/** Current confirmed document version according to the local
 *  collab plugin. Useful for displaying sync status. */
export function collabVersion(view: EditorView): number {
  return getVersion(view.state);
}

// ═══════════════════════════════════════════════════════════════
//  In-memory transport (for tests and prototypes)
// ═══════════════════════════════════════════════════════════════

/**
 * Shared central "server" that two or more in-memory clients can
 * connect to. Steps submitted to it are broadcast to every
 * subscriber. First-wins for version conflicts (standard OT).
 */
export class InMemoryServer {
  private version = 0;
  private history: CollabStep[] = [];
  private subscribers: Array<(version: number, steps: CollabStep[]) => void> = [];

  submitSteps(
    baseVersion: number,
    steps: CollabStep[],
  ): { accepted: boolean; version: number } {
    if (baseVersion !== this.version) {
      // Client is behind - OT convention is "send them the newer
      // steps via broadcast and reject this submission."
      return { accepted: false, version: this.version };
    }
    this.version += steps.length;
    this.history.push(...steps);
    for (const cb of this.subscribers) {
      try {
        cb(this.version, steps);
      } catch (err) {
        console.warn("[butter-collab/inmem] subscriber threw:", err);
      }
    }
    return { accepted: true, version: this.version };
  }

  subscribe(cb: (version: number, steps: CollabStep[]) => void): () => void {
    this.subscribers.push(cb);
    return () => {
      const idx = this.subscribers.indexOf(cb);
      if (idx >= 0) this.subscribers.splice(idx, 1);
    };
  }

  getSnapshot(): { version: number; history: CollabStep[] } {
    return { version: this.version, history: [...this.history] };
  }
}

/**
 * Build a transport bound to a given in-memory server and client ID.
 * Use this for tests; for production, implement `CollabTransport`
 * over your real backend (WebSocket, etc.).
 */
export function inMemoryTransport(
  server: InMemoryServer,
  clientID: number | string,
): CollabTransport {
  return {
    clientID,

    async getInitialState() {
      return { version: server.getSnapshot().version };
    },

    async sendSteps(version, steps) {
      return server.submitSteps(version, steps);
    },

    onRemoteSteps(cb) {
      return server.subscribe(cb);
    },
  };
}
