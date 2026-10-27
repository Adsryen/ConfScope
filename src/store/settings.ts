export interface ProxySettings {
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
}

export interface UpdateSettings {
  skipVersion: string;
  lastCheckAt: string;
  lastSeenVersion: string;
}

export interface CompareSettings {
  sortConnections: boolean;
  sortNamespaces: boolean;
}

export interface StartupSettings {
  lastOpenedVersion: string;
  lastShownWelcomeVersion: string;
  lastShownChangelogVersion: string;
}

export interface DuplicateCheckSettings {
  /** 判据①：同 key 跨配置（值相同/值不同分两档）。 */
  keyDupEnabled: boolean;
  /** 判据②：正文归一化后全等。 */
  exactBodyEnabled: boolean;
  /** 忽略的 key 模式（支持 * 通配）。字段可选，缺省空数组。 */
  ignoredKeyPatterns: string[];
}

export interface AppSettings {
  proxy: ProxySettings;
  update: UpdateSettings;
  compare: CompareSettings;
  startup: StartupSettings;
  duplicateCheck: DuplicateCheckSettings;
}

const KEY = "cs.settings";

// 写侧通知（轮47 R47-04）：读方不再靠「每次渲染重读磁盘」碰运气拿最新值。
// 通知点只有 saveSettings 一个——所有写入方（代理 / 对比 / 更新 / 启动）都汇聚到它，
// 唯一的例外是「清理缓存」从主数据文件重新水合，那里显式调用 notifySettingsChanged。
type SettingsListener = () => void;

const settingsListeners = new Set<SettingsListener>();

/** 订阅设置变化，返回取消注册函数。形态照 lib/configChangeBus。 */
export function subscribeSettings(listener: SettingsListener): () => void {
  settingsListeners.add(listener);
  return () => {
    settingsListeners.delete(listener);
  };
}

/** 广播「设置已经变了」。没有订阅者时是 no-op（纯单测环境同样安全）。 */
export function notifySettingsChanged(): void {
  // 复制一份再遍历：回调里可能触发重渲染并同步取消注册，直接遍历 Set 会被改坏。
  for (const listener of [...settingsListeners]) listener();
}

const defaults: AppSettings = {
  proxy: { httpProxy: "", httpsProxy: "", noProxy: "" },
  update: { skipVersion: "", lastCheckAt: "", lastSeenVersion: "" },
  compare: { sortConnections: true, sortNamespaces: true },
  startup: { lastOpenedVersion: "", lastShownWelcomeVersion: "", lastShownChangelogVersion: "" },
  // r110 重复检查：两判据默认开（PRD R1），忽略清单默认空。
  duplicateCheck: { keyDupEnabled: true, exactBodyEnabled: true, ignoredKeyPatterns: [] },
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
  notifySettingsChanged();
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

export function updateUpdateSettings(update: Partial<UpdateSettings>) {
  const current = loadSettings();
  saveSettings({
    ...current,
    update: {
      ...current.update,
      ...update,
    },
  });
}

export function updateStartupSettings(startup: Partial<StartupSettings>) {
  const current = loadSettings();
  saveSettings({
    ...current,
    startup: {
      ...current.startup,
      ...startup,
    },
  });
}

/** r110 重复检查设置：数组字段（ignoredKeyPatterns）调用方传整份，布尔用 patch。 */
export function updateDuplicateCheckSettings(patch: Partial<DuplicateCheckSettings>) {
  const current = loadSettings();
  saveSettings({
    ...current,
    duplicateCheck: {
      ...current.duplicateCheck,
      ...patch,
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
      lastSeenVersion: stringValue(input?.update?.lastSeenVersion),
    },
    compare: {
      sortConnections: boolValue(input?.compare?.sortConnections, defaults.compare.sortConnections),
      sortNamespaces: boolValue(input?.compare?.sortNamespaces, defaults.compare.sortNamespaces),
    },
    startup: {
      lastOpenedVersion: stringValue(input?.startup?.lastOpenedVersion),
      lastShownWelcomeVersion: stringValue(input?.startup?.lastShownWelcomeVersion),
      lastShownChangelogVersion: stringValue(input?.startup?.lastShownChangelogVersion),
    },
    // 旧文档没有这一节：全部落到默认值（两判据开、忽略清单空），不动 schemaVersion。
    duplicateCheck: {
      keyDupEnabled: boolValue(input?.duplicateCheck?.keyDupEnabled, defaults.duplicateCheck.keyDupEnabled),
      exactBodyEnabled: boolValue(input?.duplicateCheck?.exactBodyEnabled, defaults.duplicateCheck.exactBodyEnabled),
      ignoredKeyPatterns: Array.isArray(input?.duplicateCheck?.ignoredKeyPatterns)
        ? input.duplicateCheck.ignoredKeyPatterns.filter((p): p is string => typeof p === "string")
        : [],
    },
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}
