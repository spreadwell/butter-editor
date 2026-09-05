const operations = new WeakMap<object, object>();

/** Retries belong to one view/file generation and yield to explicit user input. */
export async function restoreOwnedViewport(
  owner: object,
  events: EventTarget,
  isCurrent: () => boolean,
  restore: () => boolean,
  wait: (delay: number) => Promise<void> = delay =>
    new Promise(resolve => window.setTimeout(resolve, delay)),
): Promise<void> {
  const operation = {};
  operations.set(owner, operation);
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  const inputs = ["wheel", "touchstart", "pointerdown", "keydown"];
  for (const type of inputs) events.addEventListener(type, cancel, { capture: true, passive: true });
  try {
    for (const delay of [0, 32, 100]) {
      await wait(delay);
      if (cancelled || operations.get(owner) !== operation || !isCurrent()) return;
      if (restore()) return;
    }
  } finally {
    for (const type of inputs) events.removeEventListener(type, cancel, true);
    if (operations.get(owner) === operation) operations.delete(owner);
  }
}
