const SUPPRESS_NATIVE_CLASS = "butter-mobile-suppress-native-toolbar";
const DEFAULT_SUPPRESS_MS = 700;

let suppressTimer: number | null = null;

export function suppressNativeMobileToolbar(ms = DEFAULT_SUPPRESS_MS): void {
  activeDocument.body.classList.add(SUPPRESS_NATIVE_CLASS);
  if (suppressTimer != null) {
    window.clearTimeout(suppressTimer);
  }
  suppressTimer = window.setTimeout(() => {
    suppressTimer = null;
    activeDocument.body.classList.remove(SUPPRESS_NATIVE_CLASS);
  }, ms);
}
