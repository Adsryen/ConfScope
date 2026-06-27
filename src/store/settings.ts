export interface ProxySettings {
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
}

export interface UpdateSettings {
  skipVersion: string;
  lastCheckAt: string;
}

export interface AppSettings {
  proxy: ProxySettings;
  update: UpdateSettings;
}

const KEY = "cs.settings";

const defaults: AppSettings = {
  proxy: { httpProxy: "", httpsProxy: "", noProxy: "" },
  update: { skipVersion: "", lastCheckAt: "" },
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
    },
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
