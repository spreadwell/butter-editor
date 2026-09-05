import type { App } from "obsidian";
import type { LayoutItem } from "./toolbar-layout";

export type CommandLayoutItem = Extract<LayoutItem, { type: "command" }>;

export interface ObsidianCommandDescriptor {
  id: string;
  name: string;
  icon?: string;
  checkCallback?: (checking: boolean) => boolean | void;
}

function commandRegistry(app: App): Record<string, unknown> {
  return app.commands?.commands ?? {};
}

function normalizeCommand(id: string, value: unknown): ObsidianCommandDescriptor | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as {
    id?: unknown;
    name?: unknown;
    icon?: unknown;
    checkCallback?: unknown;
  };
  const commandId = typeof raw.id === "string" && raw.id ? raw.id : id;
  const name = typeof raw.name === "string" && raw.name ? raw.name : commandId;
  return {
    id: commandId,
    name,
    icon: typeof raw.icon === "string" && raw.icon ? raw.icon : undefined,
    checkCallback: typeof raw.checkCallback === "function"
      ? raw.checkCallback as (checking: boolean) => boolean | void
      : undefined,
  };
}

export function listObsidianCommands(app: App): ObsidianCommandDescriptor[] {
  return Object.entries(commandRegistry(app))
    .map(([id, value]) => normalizeCommand(id, value))
    .filter((command): command is ObsidianCommandDescriptor => command !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getObsidianCommand(
  app: App,
  commandId: string,
): ObsidianCommandDescriptor | null {
  return normalizeCommand(commandId, commandRegistry(app)[commandId]);
}

/** Missing commands are disabled but retained so synced layouts recover when
 *  their owning plugin is installed again. Context checks are best-effort;
 *  executeCommandById remains the authority when the user activates one. */
export function isObsidianCommandAvailable(app: App, commandId: string): boolean {
  const command = getObsidianCommand(app, commandId);
  if (!command) return false;
  if (!command.checkCallback) return true;
  try {
    return command.checkCallback(true) !== false;
  } catch {
    return false;
  }
}

export function executeObsidianCommand(app: App, commandId: string): boolean {
  return app.commands?.executeCommandById(commandId) === true;
}

export function commandActionLabel(app: App, item: CommandLayoutItem): string {
  return item.label || getObsidianCommand(app, item.commandId)?.name || item.commandId;
}

export function commandActionIcon(app: App, item: CommandLayoutItem): string {
  return item.icon || getObsidianCommand(app, item.commandId)?.icon || "terminal";
}
