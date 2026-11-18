/**
 * Preferences only. Hermes owns sessions, agents, models, skills and cron; none of that is stored
 * here. Secrets never belong in settings (they live in Windows Credential Manager); a
 * connection refers to its token by `credentialId`.
 */
export const SETTINGS_VERSION = 1;

export type ThemePreference = "system" | "light" | "dark";
export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

export interface Settings {
  version: typeof SETTINGS_VERSION;
  theme: ThemePreference;
  /** Show desktop notifications for approvals and finished turns. */
  notifications: boolean;
  /** Show the edge widget with activity states. */
  edgeWidget: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  theme: "system",
  notifications: true,
  edgeWidget: true,
};

/** Keys that look like secrets are never persisted, whatever a caller passes. */
const SECRET_KEY = /token|secret|password|passwd|api[-_]?key|credential(?!id$)/i;

export function containsSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretKey);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([k, v]) => SECRET_KEY.test(k) || containsSecretKey(v));
  }
  return false;
}

/**
 * Turn untrusted stored JSON into valid settings. Unknown or invalid fields fall back to defaults
 * one by one, so a hand-edited or older file never crashes the app (and never yields half-valid state).
 */
export function normalizeSettings(raw: unknown): Settings {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    version: SETTINGS_VERSION,
    theme: THEME_PREFERENCES.includes(o.theme as ThemePreference) ? (o.theme as ThemePreference) : DEFAULT_SETTINGS.theme,
    notifications: typeof o.notifications === "boolean" ? o.notifications : DEFAULT_SETTINGS.notifications,
    edgeWidget: typeof o.edgeWidget === "boolean" ? o.edgeWidget : DEFAULT_SETTINGS.edgeWidget,
  };
}
