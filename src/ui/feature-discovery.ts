import type { MessageKey } from "../i18n";

export type FeatureDiscoverySurface =
  | "desktop-context-menu"
  | "mobile-context-menu";

export interface FeatureAnnouncement {
  id: string;
  featureId: string;
  surface: FeatureDiscoverySurface;
  title: MessageKey;
  description: MessageKey;
}

export interface FeatureDiscoverySettings {
  acknowledgedFeatureAnnouncements: string[];
  visitedFeatureDiscoveries: string[];
}

export const CONTEXT_MENU_CUSTOMIZER_FEATURE_ID =
  "context-menu-customizer-v1";

export const FEATURE_ANNOUNCEMENTS: readonly FeatureAnnouncement[] = [
  {
    id: "context-menu-customizer-desktop-v1",
    featureId: CONTEXT_MENU_CUSTOMIZER_FEATURE_ID,
    surface: "desktop-context-menu",
    title: "New: Customize this menu",
    description: "Choose its actions, order, submenus, and quick actions.",
  },
  {
    id: "context-menu-customizer-mobile-v1",
    featureId: CONTEXT_MENU_CUSTOMIZER_FEATURE_ID,
    surface: "mobile-context-menu",
    title: "New: Customize this menu",
    description: "Choose its actions, order, submenus, and quick actions.",
  },
] as const;

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string =>
    typeof item === "string" && item.length > 0
  ))];
}

export function initializeFeatureDiscoverySettings(
  raw: Record<string, unknown>,
): FeatureDiscoverySettings & { changed: boolean } {
  const existingInstall = raw.hasCompletedOnboarding === true;
  const rawAcknowledged = raw.acknowledgedFeatureAnnouncements;
  const rawVisited = raw.visitedFeatureDiscoveries;
  const acknowledgedFeatureAnnouncements = Array.isArray(rawAcknowledged)
    ? normalizeIds(rawAcknowledged)
    : existingInstall
      ? []
      : FEATURE_ANNOUNCEMENTS.map(({ id }) => id);
  const allFeatureIds = [...new Set(
    FEATURE_ANNOUNCEMENTS.map(({ featureId }) => featureId),
  )];
  const visitedFeatureDiscoveries = Array.isArray(rawVisited)
    ? normalizeIds(rawVisited)
    : existingInstall
      ? []
      : allFeatureIds;
  return {
    acknowledgedFeatureAnnouncements,
    visitedFeatureDiscoveries,
    changed:
      JSON.stringify(rawAcknowledged) !==
        JSON.stringify(acknowledgedFeatureAnnouncements) ||
      JSON.stringify(rawVisited) !== JSON.stringify(visitedFeatureDiscoveries),
  };
}

/** Registry order is priority order, so no surface can show two notices. */
export function pendingFeatureAnnouncement(
  settings: FeatureDiscoverySettings,
  surface: FeatureDiscoverySurface,
): FeatureAnnouncement | null {
  const acknowledged = new Set(settings.acknowledgedFeatureAnnouncements);
  return FEATURE_ANNOUNCEMENTS.find(
    (announcement) =>
      announcement.surface === surface && !acknowledged.has(announcement.id),
  ) ?? null;
}

export function hasVisitedFeature(
  settings: FeatureDiscoverySettings,
  featureId: string,
): boolean {
  return settings.visitedFeatureDiscoveries.includes(featureId);
}
