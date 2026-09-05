export interface DesktopContextMenuParams {
  x: number;
  y: number;
  misspelledWord: string;
  dictionarySuggestions: string[];
}

type ElectronContextMenuParams = {
  x?: unknown;
  y?: unknown;
  misspelledWord?: unknown;
  dictionarySuggestions?: unknown;
};

type ElectronIpcRenderer = {
  once: (
    name: "context-menu",
    listener: (event: unknown, params: ElectronContextMenuParams) => void,
  ) => void;
  removeListener: (
    name: "context-menu",
    listener: (event: unknown, params: ElectronContextMenuParams) => void,
  ) => void;
  send: (name: "context-menu") => void;
};

type ElectronRuntime = {
  ipcRenderer?: ElectronIpcRenderer;
  remote?: {
    getCurrentWebContents?: () => {
      session?: {
        addWordToSpellCheckerDictionary?: (word: string) => boolean;
      };
    };
  };
};

export interface DesktopContextMenuBridge {
  /**
   * Reserve Obsidian's next Electron context-menu event, suppressing its
   * native menu before opening Butter's menu with Chromium's spellcheck data.
   */
  defer: (
    event: MouseEvent,
    open: (params: DesktopContextMenuParams) => void,
  ) => boolean;
  addWordToDictionary: (word: string) => boolean;
  destroy: () => void;
}

const CONTEXT_MENU_TIMEOUT_MS = 1_000;

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function electronRuntime(ownerWindow: Window): ElectronRuntime | null {
  try {
    const exposedRuntime = ownerWindow as Window & {
      electron?: ElectronRuntime;
      require?: (id: string) => unknown;
    };
    if (exposedRuntime.electron) return exposedRuntime.electron;
    return exposedRuntime.require?.("electron") as ElectronRuntime | undefined ?? null;
  } catch {
    return null;
  }
}

export function createDesktopContextMenuBridge(
  ownerWindow: Window = window,
): DesktopContextMenuBridge | null {
  const runtime = electronRuntime(ownerWindow);
  const ipcRenderer = runtime?.ipcRenderer;
  if (!ipcRenderer?.once || !ipcRenderer.removeListener || !ipcRenderer.send) return null;

  let pendingListener: ((event: unknown, params: ElectronContextMenuParams) => void) | null = null;
  let pendingTimeout: number | null = null;

  const clearPending = (): void => {
    if (pendingListener) ipcRenderer.removeListener("context-menu", pendingListener);
    if (pendingTimeout !== null) ownerWindow.clearTimeout(pendingTimeout);
    pendingListener = null;
    pendingTimeout = null;
  };

  return {
    defer: (event, open) => {
      clearPending();
      const fallback = {
        x: event.clientX,
        y: event.clientY,
        misspelledWord: "",
        dictionarySuggestions: [],
      };
      const onContextMenu = (_event: unknown, raw: ElectronContextMenuParams): void => {
        clearPending();
        open({
          x: finiteNumber(raw?.x, fallback.x),
          y: finiteNumber(raw?.y, fallback.y),
          misspelledWord: typeof raw?.misspelledWord === "string" ? raw.misspelledWord : "",
          dictionarySuggestions: stringArray(raw?.dictionarySuggestions),
        });
      };
      pendingListener = onContextMenu;
      ipcRenderer.once("context-menu", onContextMenu);
      pendingTimeout = ownerWindow.setTimeout(() => {
        clearPending();
        open(fallback);
      }, CONTEXT_MENU_TIMEOUT_MS);

      // This is Obsidian's renderer-side handshake: reserve the next Electron
      // context event before Chromium emits it, and keep the DOM event away
      // from competing editor handlers. Obsidian's main process then returns
      // the spelling payload instead of opening its native context menu.
      event.stopPropagation();
      event.stopImmediatePropagation();
      ipcRenderer.send("context-menu");
      return true;
    },
    addWordToDictionary: (word) => {
      try {
        return runtime?.remote?.getCurrentWebContents?.().session
          ?.addWordToSpellCheckerDictionary?.(word) === true;
      } catch {
        return false;
      }
    },
    destroy: clearPending,
  };
}
