export interface DiffViewSourcePreference {
  connId: string;
  tenant: string;
  dataId: string;
  group: string;
  usesDefaultNamespace: boolean;
}

export type DiffViewModePreference = "text" | "key" | "lines";

export interface DiffViewPreferences {
  selectedProject: string;
  left: DiffViewSourcePreference;
  right: DiffViewSourcePreference;
  mode: DiffViewModePreference;
}

const STORAGE_KEY = "cs.diffViewPreferences";

const defaults: DiffViewPreferences = {
  selectedProject: "",
  left: {
    connId: "",
    tenant: "",
    dataId: "",
    group: "DEFAULT_GROUP",
    usesDefaultNamespace: true,
  },
  right: {
    connId: "",
    tenant: "",
    dataId: "",
    group: "DEFAULT_GROUP",
    usesDefaultNamespace: true,
  },
  mode: "text",
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeSource(value: unknown, fallback: DiffViewSourcePreference): DiffViewSourcePreference {
  if (!value || typeof value !== "object") return { ...fallback };
  const raw = value as Partial<DiffViewSourcePreference>;
  return {
    connId: stringValue(raw.connId),
    tenant: stringValue(raw.tenant),
    dataId: stringValue(raw.dataId),
    group: stringValue(raw.group) || "DEFAULT_GROUP",
    usesDefaultNamespace: boolValue(raw.usesDefaultNamespace, true),
  };
}

function normalizeMode(value: unknown): DiffViewModePreference {
  return value === "text" || value === "key" || value === "lines" ? value : "text";
}

function normalizePreferences(value: unknown): DiffViewPreferences {
  if (!value || typeof value !== "object") return structuredClone(defaults);
  const raw = value as Partial<DiffViewPreferences>;
  return {
    selectedProject: stringValue(raw.selectedProject),
    left: normalizeSource(raw.left, defaults.left),
    right: normalizeSource(raw.right, defaults.right),
    mode: normalizeMode(raw.mode),
  };
}

export function loadDiffViewPreferences(): DiffViewPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(defaults);
    return normalizePreferences(JSON.parse(raw));
  } catch {
    return structuredClone(defaults);
  }
}

export function saveDiffViewPreferences(preferences: DiffViewPreferences) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizePreferences(preferences)));
}
