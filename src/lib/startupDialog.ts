import type { AppSettings } from "../store/settings";

export type StartupDialogKind = "welcome" | "updated";

interface StartupDialogInput {
  currentVersion: string;
  settings: AppSettings;
  hasExistingAppData: boolean;
}

const EXISTING_DATA_KEYS = ["cs.connections", "cs.settings", "cs.operationHistory", "cs.sshProfiles", "cs.ui"];

export function hasExistingStartupData(): boolean {
  try {
    return EXISTING_DATA_KEYS.some((key) => localStorage.getItem(key) !== null);
  } catch {
    return false;
  }
}

export function startupDialogKind({ currentVersion, settings, hasExistingAppData }: StartupDialogInput): StartupDialogKind | null {
  const version = currentVersion.trim();
  if (!version) return null;
  if (settings.startup.lastShownWelcomeVersion === version || settings.startup.lastShownChangelogVersion === version) {
    return null;
  }
  if (hasExistingAppData) {
    return "updated";
  }
  return "welcome";
}
