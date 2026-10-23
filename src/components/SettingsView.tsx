import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n";
import { countMigratableStoredCredentials, migrateStoredCredentials, type CredentialMigrationSummary } from "../lib/credentialSecrets";
import { clearAppCache } from "../lib/cacheCleanup";
import { formatDateTime } from "../lib/formatDateTime";
import { formatBytes } from "../lib/formatBytes";
import { getAppDataDocInfo, type AppDataDocInfo } from "../lib/appDataDoc";
import { loadAppDataBackupState } from "../store/appDataBackup";
import { clearOperationHistory } from "../store/operationHistory";
import { loadSettings, saveSettings, type AppSettings } from "../store/settings";
import AppDataBackupPanel from "./AppDataBackupPanel";
import ConfirmModal from "./ConfirmModal";
import CopyButton from "./CopyButton";
import InlineError from "./InlineError";
import {
  CheckDataRootRollback,
  GetDataLocations,
  GetRuntimeLayout,
  MigrateDataRoot,
  OpenDataFolder,
  PlanDataRootMigration,
  RollbackDataRoot,
  SelectDataRootDirectory,
  type DataLocations,
  type DataRootRollbackStatus,
  type RuntimeLayoutInfo,
} from "../../wailsjs/go/app/App";
import LanguageSwitch from "./LanguageSwitch";
import { useSectionSpy } from "../lib/sectionSpy";
import { errorText } from "../lib/errorText";
import { statusMessageProps } from "../lib/statusSemantics";

/**
 * 左栏索引与章节的一一对应（顺序 = 文档顺序）。
 *
 * scroll-spy 按「最后一个越过判定线的节」答当前节，靠的就是这个顺序与 DOM 一致，
 * 所以章节增删必须同时改这张表和下面对应的 `<section>`，两者错序高亮就会指错地方。
 */
const SECTION_NAV: ReadonlyArray<{ id: string; labelKey: string }> = [
  { id: "settings-general", labelKey: "settings.groupBasic" },
  { id: "settings-network", labelKey: "settings.groupNetwork" },
  { id: "settings-compare", labelKey: "settings.comparePreferences" },
  { id: "settings-credentials", labelKey: "settings.credentials" },
  { id: "settings-backup", labelKey: "settings.backup" },
  { id: "settings-data-locations", labelKey: "settings.dataLocations" },
  { id: "settings-update", labelKey: "settings.update" },
  { id: "settings-developer", labelKey: "settings.developer" },
];
const SECTION_IDS = SECTION_NAV.map((item) => item.id);

/** 数据根命中档位的展示标签键（Go 侧 RootSource 的稳定字面量，逐档一条 i18n）。 */
const DATA_ROOT_SOURCE_KEYS: Record<string, string> = {
  env: "settings.dataRootSourceEnv",
  "user-choice": "settings.dataRootSourceUserChoice",
  "install-marker": "settings.dataRootSourceInstallMarker",
  "legacy-adoption": "settings.dataRootSourceLegacyAdoption",
  "exe-adjacent": "settings.dataRootSourceExeAdjacent",
  "os-user-data": "settings.dataRootSourceOsUserData",
};

export default function SettingsView() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [saved, setSaved] = useState(false);
  const [credentialPending, setCredentialPending] = useState(() => countMigratableStoredCredentials());
  const [credentialSummary, setCredentialSummary] = useState<CredentialMigrationSummary | null>(null);
  const [credentialError, setCredentialError] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheResult, setCacheResult] = useState<"" | "ok" | "fail">("");
  const [docInfo, setDocInfo] = useState<AppDataDocInfo | null>(null);
  // 轮47 R47-03：「最后备份」不再在渲染体里读盘。原来那段 IIFE 有两个毛病：
  // 一是设置页每次重渲染（包括在任意输入框里打字）都要解析整个备份活动列表；
  // 二是它只在页面恰好重渲染时才变——显示的是渲染时序，不是数据。
  // 现在由 AppDataBackupPanel 在写完的那一刻上报活动列表（见 onActivitiesChange）。
  const [backupActivities, setBackupActivities] = useState(() => loadAppDataBackupState().activities);
  const lastBackupAt = backupActivities.find((item) => item.status === "success")?.createdAt ?? "";
  const [dataLocations, setDataLocations] = useState<DataLocations | null>(null);
  const [openFolderBusy, setOpenFolderBusy] = useState(false);
  const [openFolderError, setOpenFolderError] = useState("");
  // 轮62：数据根运行形态（便携/安装 + 命中哪一档解析规则）与换根迁移状态。
  const [runtimeLayout, setRuntimeLayout] = useState<RuntimeLayoutInfo | null>(null);
  const [rollbackStatus, setRollbackStatus] = useState<DataRootRollbackStatus | null>(null);
  const [dataRootBusy, setDataRootBusy] = useState(false);
  const [dataRootError, setDataRootError] = useState("");
  // 迁移/回退写完指针后的「需重启」提示：数据目录没真的换，别让界面假装已经换好了。
  const [restartNotice, setRestartNotice] = useState("");
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    message: string;
    details?: string[];
    danger?: boolean;
    action: () => void;
  } | null>(null);
  const askConfirm = (title: string, message: string, action: () => void, details?: string[], danger = true) =>
    setPendingConfirm({ title, message, details, danger, action });
  const panelsRef = useRef<HTMLDivElement | null>(null);
  const { activeId, jumpToSection } = useSectionSpy(panelsRef, SECTION_IDS);
  const savedTimerRef = useRef<number | null>(null);

  const sectionLinks = SECTION_NAV.map((item) => ({ id: item.id, label: t(item.labelKey) }));

  const update = (patch: Partial<AppSettings>) => {
    const next = {
      ...settings,
      ...patch,
      proxy: { ...settings.proxy, ...(patch.proxy ?? {}) },
      compare: { ...settings.compare, ...(patch.compare ?? {}) },
      update: { ...settings.update, ...(patch.update ?? {}) },
    };
    setSettings(next);
    saveSettings(next);
    setSaved(true);
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => {
      setSaved(false);
      savedTimerRef.current = null;
    }, 1200);
  };

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
        savedTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void getAppDataDocInfo().then((info) => {
      if (alive) setDocInfo(info);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 数据位置、运行形态、能否回退三者同源（都跟着当前数据根走），所以一起刷一次：
  // 迁移或回退写完指针后只刷列表，界面上会出现「新列表 + 旧回退入口」这种自相矛盾的组合。
  // 降级环境（没有原生绑定）逐个吞掉异常，区块自行显示不可用提示，不整树崩溃。
  const surfacesAliveRef = useRef(true);
  const refreshDataSurfaces = useCallback(() => {
    // 每个绑定各自包一次 try：降级构建里 window.go 整个没有、旧 Go 二进制里根本没有新方法，
    // 这两种都是同步抛异常（.catch 接不住），缺哪个就只让哪块信息缺席，不能带走整个设置页。
    const safeCall = <T,>(call: () => Promise<T>, apply: (value: T) => void) => {
      try {
        void call()
          .then((value) => {
            if (surfacesAliveRef.current && value) apply(value);
          })
          .catch(() => undefined);
      } catch {
        // 绑定缺失：对应区块保持未加载态，按不可用降级显示
      }
    };
    safeCall(GetDataLocations, (locs) => {
      if (Array.isArray(locs.entries) && locs.entries.length > 0) {
        setDataLocations(locs);
      }
    });
    safeCall(GetRuntimeLayout, (info) => {
      if (!info.error) {
        setRuntimeLayout(info);
      }
    });
    safeCall(CheckDataRootRollback, (status) => {
      setRollbackStatus(status);
    });
  }, []);

  useEffect(() => {
    surfacesAliveRef.current = true;
    refreshDataSurfaces();
    return () => {
      surfacesAliveRef.current = false;
    };
  }, [refreshDataSurfaces]);

  const runCredentialMigration = async () => {
    setCredentialError("");
    setCredentialSummary(null);
    setCredentialBusy(true);
    try {
      const summary = await migrateStoredCredentials();
      setCredentialSummary(summary);
      setCredentialPending(countMigratableStoredCredentials());
    } catch (e) {
      setCredentialError(errorText(e));
    } finally {
      setCredentialBusy(false);
    }
  };

  const runOpenDataFolder = async (key: string) => {
    setOpenFolderError("");
    setOpenFolderBusy(true);
    try {
      await OpenDataFolder(key);
    } catch (e) {
      setOpenFolderError(errorText(e));
    } finally {
      setOpenFolderBusy(false);
    }
  };

  // 换数据根：选目录 → 让 Go 侧算一次迁移计划 → 把计划里的事实摆进确认框 → 用户点「应用」才真动。
  // 分两步是因为「目标位置能不能迁」必须在原生侧判（同根、互相包含、已有另一份数据、不可写），
  // 前端自己拼规则就会出现两边判得不一样；判据只在 Go 侧一处。
  const runChangeDataRoot = async () => {
    if (dataRootBusy) return;
    setDataRootError("");
    setDataRootBusy(true);
    try {
      const target = ((await SelectDataRootDirectory()) ?? "").trim();
      // 取消目录选择：原生绑定返回空串，此时什么都不改，也不报「目标位置为空」。
      if (target === "") return;
      const plan = await PlanDataRootMigration(target);
      if (!plan) {
        setDataRootError(t("settings.dataRootPlanUnavailable"));
        return;
      }
      if (!plan.valid) {
        setDataRootError(plan.error || t("settings.dataRootPlanUnavailable"));
        return;
      }
      const details = [
        t("settings.dataRootMigrateFromTo", { from: plan.source, to: plan.target }),
        t("settings.dataRootMigrateItems", {
          count: plan.itemCount,
          size: formatBytes(plan.totalBytes),
        }),
        t("settings.dataRootMigrateKeepsSource"),
        t("settings.dataRootMigrateRestartNote"),
      ];
      if (plan.reusedItems > 0) {
        details.push(t("settings.dataRootMigrateReused", { count: plan.reusedItems }));
      }
      for (const warning of plan.warnings ?? []) {
        details.push(warning);
      }
      askConfirm(t("settings.dataRootMigrateTitle"), t("settings.dataRootMigrateMessage"), () => {
        void runMigrateDataRoot(plan.target);
      }, details, false);
    } catch (e) {
      setDataRootError(errorText(e));
    } finally {
      setDataRootBusy(false);
    }
  };

  const runMigrateDataRoot = async (target: string) => {
    setDataRootError("");
    setDataRootBusy(true);
    try {
      const result = await MigrateDataRoot(target);
      if (!result) {
        setDataRootError(t("settings.dataRootPlanUnavailable"));
        return;
      }
      if (result.error) {
        // Go 侧失败时不写指针也不删旧根，界面回到「还没迁」的状态，只把原因显示出来。
        setDataRootError(result.error);
        return;
      }
      setRestartNotice(result.restartReason || t("settings.dataRootRestartPending"));
      refreshDataSurfaces();
    } catch (e) {
      setDataRootError(errorText(e));
    } finally {
      setDataRootBusy(false);
    }
  };

  // 回退只改指针、不碰任何数据，所以两侧的主数据文件摘要都要摆出来：
  // 用户真正要比的是「旧位置那份是不是我还认的那份」。
  const askRollbackDataRoot = () => {
    if (!rollbackStatus?.available) return;
    const details = [
      t("settings.dataRootRollbackFromTo", { from: rollbackStatus.currentRoot, to: rollbackStatus.previousRoot }),
      t("settings.dataRootRollbackCurrentDoc", {
        savedAt: formatDateTime(rollbackStatus.currentDoc.savedAt) || t("settings.dataRootDocNone"),
        size: formatBytes(rollbackStatus.currentDoc.sizeBytes),
      }),
      t("settings.dataRootRollbackPreviousDoc", {
        savedAt: formatDateTime(rollbackStatus.previousDoc.savedAt) || t("settings.dataRootDocNone"),
        size: formatBytes(rollbackStatus.previousDoc.sizeBytes),
      }),
      t("settings.dataRootRollbackRestartNote"),
    ];
    askConfirm(t("settings.dataRootRollbackTitle"), t("settings.dataRootRollbackMessage"), () => {
      void runRollbackDataRoot();
    }, details, false);
  };

  const runRollbackDataRoot = async () => {
    setDataRootError("");
    setDataRootBusy(true);
    try {
      const result = await RollbackDataRoot();
      if (!result) {
        setDataRootError(t("settings.dataRootPlanUnavailable"));
        return;
      }
      if (result.error) {
        setDataRootError(result.error);
        return;
      }
      setRestartNotice(result.restartReason || t("settings.dataRootRestartPending"));
      refreshDataSurfaces();
    } catch (e) {
      setDataRootError(errorText(e));
    } finally {
      setDataRootBusy(false);
    }
  };

  const runClearCache = async () => {
    setCacheBusy(true);
    setCacheResult("");
    try {
      await clearAppCache();
      setCacheResult("ok");
    } catch {
      setCacheResult("fail");
    } finally {
      setCacheBusy(false);
    }
  };

  return (
    <div className="page-surface settings-page">
      <div className="page-header">
        <div>
          <h3>{t("app.settings")}</h3>
          <div className="page-subtitle">{t("app.settingsSubtitle")}</div>
        </div>
        {saved && (
          <div className="test-msg ok" {...statusMessageProps("success")}>
            {t("settings.settingsSaved")}
          </div>
        )}
      </div>
      <div className="settings-workbench">
        <aside className="settings-rail" aria-label={t("app.settings")}>
          {sectionLinks.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`settings-rail-item${activeId === item.id ? " active" : ""}`}
              aria-current={activeId === item.id ? "true" : undefined}
              onClick={() => jumpToSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </aside>

        <div ref={panelsRef} className="settings-panels">
          <section id="settings-general" className="settings-panel" tabIndex={-1} aria-labelledby="settings-general-title">
            <div className="settings-panel-head">
              <h4 id="settings-general-title">{t("settings.groupBasic")}</h4>
              <div className="settings-panel-description">{t("settings.generalDescription")}</div>
            </div>
            <label className="settings-setting-row">
              <span>{t("app.language")}</span>
              <LanguageSwitch />
            </label>
            <div className="settings-panel-note">{t("settings.connectionScopedNote")}</div>
          </section>

          <section id="settings-network" className="settings-panel" tabIndex={-1} aria-labelledby="settings-network-title">
            <div className="settings-panel-head">
              <h4 id="settings-network-title">{t("settings.groupNetwork")}</h4>
              <div className="settings-panel-description">{t("settings.networkDescription")}</div>
            </div>
            <div className="settings-proxy-grid">
              <label className="field">
                <span>{t("settings.httpProxy")}</span>
                <input
                  type="text"
                  className="search-input"
                  value={settings.proxy.httpProxy}
                  placeholder="http://127.0.0.1:7890"
                  onChange={(e) => update({ proxy: { ...settings.proxy, httpProxy: e.target.value } })}
                />
              </label>
              <label className="field">
                <span>{t("settings.httpsProxy")}</span>
                <input
                  type="text"
                  className="search-input"
                  value={settings.proxy.httpsProxy}
                  placeholder="http://127.0.0.1:7890"
                  onChange={(e) => update({ proxy: { ...settings.proxy, httpsProxy: e.target.value } })}
                />
              </label>
              <label className="field">
                <span>{t("settings.noProxy")}</span>
                <input
                  type="text"
                  className="search-input"
                  value={settings.proxy.noProxy}
                  placeholder="localhost,127.0.0.1"
                  onChange={(e) => update({ proxy: { ...settings.proxy, noProxy: e.target.value } })}
                />
              </label>
            </div>
          </section>

          <section id="settings-compare" className="settings-panel" tabIndex={-1} aria-labelledby="settings-compare-title">
            <div className="settings-panel-head">
              <h4 id="settings-compare-title">{t("settings.comparePreferences")}</h4>
              <div className="settings-panel-description">{t("settings.compareDescription")}</div>
            </div>
            <label className="settings-setting-row">
              <span>{t("settings.sortConnections")}</span>
              <input
                type="checkbox"
                checked={settings.compare.sortConnections}
                onChange={(e) => update({ compare: { ...settings.compare, sortConnections: e.target.checked } })}
              />
            </label>
            <label className="settings-setting-row">
              <span>{t("settings.sortNamespaces")}</span>
              <input
                type="checkbox"
                checked={settings.compare.sortNamespaces}
                onChange={(e) => update({ compare: { ...settings.compare, sortNamespaces: e.target.checked } })}
              />
            </label>
          </section>

          <section id="settings-credentials" className="settings-panel" tabIndex={-1} aria-labelledby="settings-credentials-title">
            <div className="settings-panel-head">
              <h4 id="settings-credentials-title">{t("settings.credentials")}</h4>
              <div className="settings-panel-description">{t("settings.credentialsDescription")}</div>
            </div>
            <div className="settings-setting-row">
              <div>
                <strong>{t("settings.credentialMigrationTitle")}</strong>
                <div className="settings-panel-description">
                  {credentialPending > 0
                    ? t("settings.credentialMigrationPending", { count: credentialPending })
                    : t("settings.credentialMigrationNone")}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={credentialBusy || credentialPending === 0}
                onClick={runCredentialMigration}
              >
                {credentialBusy ? t("settings.migratingCredentials") : t("settings.migrateCredentials")}
              </button>
            </div>
            {credentialSummary && (
              <div className="test-msg ok" {...statusMessageProps("success")}>
                <span className="test-msg-text">
                  {t("settings.credentialMigrationSummary", {
                    migrated: credentialSummary.migrated,
                    unsupported: credentialSummary.unsupported,
                    failed: credentialSummary.failed,
                  })}
                </span>
              </div>
            )}
            {credentialError && <InlineError title={t("settings.credentialMigrationFailed")} message={credentialError} />}
          </section>

          <section id="settings-backup" className="settings-panel settings-backup-panel" tabIndex={-1} aria-labelledby="settings-backup-title">
            <div className="settings-panel-head">
              <h4 id="settings-backup-title">{t("settings.backup")}</h4>
              <div className="settings-panel-description">{t("settings.backupDescription")}</div>
            </div>
            {docInfo && (
              <div className="settings-setting-row settings-data-file-row">
                <div>
                  <strong>{t("settings.dataFile")}</strong>
                  <div className="settings-panel-description">{t("settings.dataFileDescription")}</div>
                </div>
                <div className="data-file-info">
                  <div>
                    {t("settings.dataFilePath")}: <code>{docInfo.path || t("settings.dataFileNone")}</code>
                  </div>
                  {docInfo.savedAt && (
                    <div>
                      {t("settings.dataFileLastSaved")}: {formatDateTime(docInfo.savedAt)}
                    </div>
                  )}
                  {lastBackupAt ? (
                    <div>
                      {t("settings.dataFileLastBackup")}: {formatDateTime(lastBackupAt)}
                    </div>
                  ) : null}
                </div>
              </div>
            )}
            <AppDataBackupPanel onActivitiesChange={setBackupActivities} />
            <div className="settings-setting-row settings-danger-zone">
              <div>
                <strong>{t("settings.dangerZone")}</strong>
                <div className="settings-panel-description">{t("settings.clearHistoryHint")}</div>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-danger"
                onClick={() => askConfirm(t("settings.clearLocalHistory"), t("operationHistory.confirmClear"), clearOperationHistory)}
              >
                {t("settings.clearLocalHistory")}
              </button>
            </div>
          </section>

          <section id="settings-data-locations" className="settings-panel" tabIndex={-1} aria-labelledby="settings-data-locations-title">
            <div className="settings-panel-head">
              <h4 id="settings-data-locations-title">{t("settings.dataLocations")}</h4>
              <div className="settings-panel-description">{t("settings.dataLocationsDescription")}</div>
            </div>
            {/* 运行形态：便携版跟着 exe 走、安装版落系统用户数据目录，出问题时第一件要看的就是
                「它到底命中了哪一档解析规则」，所以档位、判定依据和备注都摆在这一层，不藏进 tooltip。 */}
            {runtimeLayout && (
              <div className="settings-setting-row settings-data-root-row">
                <div>
                  <strong>{t("settings.dataRootRuntime")}</strong>
                  <div className="settings-data-root-facts">
                    <span>
                      {t("settings.dataRootMode")}：<code>{t(`settings.dataRootMode${runtimeLayout.mode.charAt(0).toUpperCase()}${runtimeLayout.mode.slice(1)}`)}</code>
                    </span>
                    <span>
                      {t("settings.dataRootSource")}：
                      <code>{t(DATA_ROOT_SOURCE_KEYS[runtimeLayout.source] ?? "settings.dataRootSourceUnknown")}</code>
                    </span>
                  </div>
                  {(runtimeLayout.notes?.length ?? 0) > 0 && (
                    <ul className="settings-data-root-notes">
                      {runtimeLayout.notes.map((note) => (
                        <li key={note}>{note}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="settings-data-location-actions">
                  <button type="button" className="btn btn-ghost btn-sm" disabled={dataRootBusy} onClick={() => void runChangeDataRoot()}>
                    {t("settings.dataRootChange")}
                  </button>
                  {rollbackStatus?.available && (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={dataRootBusy} onClick={askRollbackDataRoot}>
                      {t("settings.dataRootRollback")}
                    </button>
                  )}
                </div>
              </div>
            )}
            {dataLocations ? (
              <div className="settings-data-locations">
                {dataLocations.entries.map((entry) => (
                  <div key={entry.key} className="settings-setting-row">
                    <div>
                      <strong>
                        {t(`settings.dataLoc${entry.key.charAt(0).toUpperCase()}${entry.key.slice(1)}`)}
                        {!entry.exists && <span className="settings-data-location-missing">{t("settings.dataLocMissing")}</span>}
                      </strong>
                      <div className="settings-data-location-path" title={entry.path}>
                        <code>{entry.path}</code>
                      </div>
                    </div>
                    <div className="settings-data-location-actions">
                      <CopyButton text={entry.path} />
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        disabled={openFolderBusy || !entry.exists}
                        onClick={() => {
                          if (openFolderBusy || !entry.exists) return;
                          void runOpenDataFolder(entry.key);
                        }}
                      >
                        {t("settings.openFolder")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="settings-panel-note">{t("settings.dataLocationsUnavailable")}</div>
            )}
            {restartNotice && (
              <div className="test-msg warn" {...statusMessageProps("info")}>
                <span className="test-msg-text">{restartNotice}</span>
              </div>
            )}
            {dataRootError && (
              <div className="inline-error" role="alert">
                {t("settings.dataRootActionFailed", { error: dataRootError })}
              </div>
            )}
            {openFolderError && (
              <div className="inline-error" role="alert">
                {t("settings.openFolderFailed", { error: openFolderError })}
              </div>
            )}
          </section>
          <section id="settings-update" className="settings-panel" tabIndex={-1} aria-labelledby="settings-update-title">
            <div className="settings-panel-head">
              <h4 id="settings-update-title">{t("settings.update")}</h4>
              <div className="settings-panel-description">{t("settings.updateDescription")}</div>
            </div>
            <div className="settings-setting-row">
              <div>
                <strong>{t("settings.lastUpdateCheck")}</strong>
              </div>
              <code>{settings.update.lastCheckAt ? formatDateTime(settings.update.lastCheckAt) : t("settings.updateNeverChecked")}</code>
            </div>
            <div className="settings-setting-row">
              <div>
                <strong>{t("settings.lastSeenUpdateVersion")}</strong>
              </div>
              <code>{settings.update.lastSeenVersion || t("settings.noSeenUpdateVersion")}</code>
            </div>
            <div className="settings-setting-row">
              <div>
                <strong>{t("settings.skippedUpdateVersion")}</strong>
                <div className="settings-panel-description">{t("settings.updateSkipHint")}</div>
              </div>
              <div className="settings-update-skip">
                <code>{settings.update.skipVersion || t("settings.noSkippedUpdateVersion")}</code>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={!settings.update.skipVersion}
                  onClick={() => update({ update: { ...settings.update, skipVersion: "" } })}
                >
                  {t("settings.restoreUpdateReminder")}
                </button>
              </div>
            </div>
          </section>

          <section id="settings-developer" className="settings-panel" tabIndex={-1} aria-labelledby="settings-developer-title">
            <div className="settings-panel-head">
              <h4 id="settings-developer-title">{t("settings.developer")}</h4>
              <div className="settings-panel-description">{t("settings.developerDescription")}</div>
            </div>
            <div className="settings-setting-row">
              <div>
                <strong>{t("settings.clearCache")}</strong>
                <div className="settings-panel-description">{t("settings.clearCacheHint")}</div>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-danger"
                disabled={cacheBusy}
                onClick={() => askConfirm(t("settings.clearCache"), t("settings.confirmClearCache"), () => void runClearCache())}
              >
                {cacheBusy ? "…" : t("settings.clearCache")}
              </button>
            </div>
            {cacheResult === "ok" && (
              <div className="test-msg ok" {...statusMessageProps("success")}>
                {t("settings.clearCacheSuccess")}
              </div>
            )}
            {cacheResult === "fail" && (
              <div className="inline-error" role="alert">
                {t("settings.clearCacheFailed")}
              </div>
            )}
          </section>
        </div>
      </div>

      {pendingConfirm && (
        <ConfirmModal
          title={pendingConfirm.title}
          message={pendingConfirm.message}
          details={pendingConfirm.details}
          danger={pendingConfirm.danger !== false}
          onConfirm={() => {
            const action = pendingConfirm.action;
            setPendingConfirm(null);
            action();
          }}
          onCancel={() => setPendingConfirm(null)}
        />
      )}
    </div>
  );
}
