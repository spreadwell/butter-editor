export interface RichFormattingPreferenceState {
  enableHtmlFormatting: boolean;
  hasCompletedOnboarding: boolean;
}

export interface OnboardingPreferenceState
  extends RichFormattingPreferenceState {
  markdownShortcuts: MarkdownShortcutSettings;
}

export function initialRichFormattingChoice(
  settings: RichFormattingPreferenceState,
): boolean {
  return settings.hasCompletedOnboarding
    ? settings.enableHtmlFormatting
    : false;
}

export function applyRichFormattingChoice(
  settings: RichFormattingPreferenceState,
  enabled: boolean,
): void {
  settings.enableHtmlFormatting = enabled;
  settings.hasCompletedOnboarding = true;
}

export function applyOnboardingChoices(
  settings: OnboardingPreferenceState,
  richFormattingEnabled: boolean,
  markdownShortcutsEnabled: boolean,
): void {
  applyRichFormattingChoice(settings, richFormattingEnabled);
  settings.markdownShortcuts = withCommonMarkdownShortcuts(
    settings.markdownShortcuts,
    markdownShortcutsEnabled,
  );
}
import {
  type MarkdownShortcutSettings,
  withCommonMarkdownShortcuts,
} from "../editor/markdown-shortcuts";
