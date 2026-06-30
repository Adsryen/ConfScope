export interface ProxySettings {
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
}

export interface UpdateSettings {
  skipVersion: string;
  lastCheckAt: string;
  proxyOnlyForUpdate: boolean;
}

export interface CompareSettings {
  sortConnections: boolean;
  sortNamespaces: boolean;
}

export interface AppSettings {
  proxy: ProxySettings;
  update: UpdateSettings;
  compare: CompareSettings;
}

const KEY = "cs.settings";

const defaults: AppSettings = {
  proxy: { httpProxy: "", httpsProxy: "", noProxy: "" },
  update: { skipVersion: "", lastCheckAt: "", proxyOnlyForUpdate: true },
  compare: { sortConnections: true, sortNamespaces: true },
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(defaults);
    const parsed = JSON.parse(raw);
    return normalizeSettings(parsed);
  } catch {
    return structuredClone(defaults);
  }
}

export function saveSettings(settings: AppSettings) {
  localStorage.setItem(KEY, JSON.stringify(normalizeSettings(settings)));
}

export function updateProxySettings(proxy: Partial<ProxySettings>) {
  const current = loadSettings();
  saveSettings({
    ...current,
    proxy: {
      ...current.proxy,
      ...proxy,
    },
  });
}

export function updateCompareSettings(compare: Partial<CompareSettings>) {
  const current = loadSettings();
  saveSettings({
    ...current,
    compare: {
      ...current.compare,
      ...compare,
    },
  });
}

function normalizeSettings(value: unknown): AppSettings {
  const input = value as Partial<AppSettings>;
  return {
    proxy: {
      httpProxy: stringValue(input?.proxy?.httpProxy),
      httpsProxy: stringValue(input?.proxy?.httpsProxy),
      noProxy: stringValue(input?.proxy?.noProxy),
    },
    update: {
      skipVersion: stringValue(input?.update?.skipVersion),
      lastCheckAt: stringValue(input?.update?.lastCheckAt),
      proxyOnlyForUpdate: boolValue(input?.update?.proxyOnlyForUpdate, defaults.update.proxyOnlyForUpdate),
    },
    compare: {
      sortConnections: boolValue(input?.compare?.sortConnections, defaults.compare.sortConnections),
      sortNamespaces: boolValue(input?.compare?.sortNamespaces, defaults.compare.sortNamespaces),
    },
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
