import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Connection,
  connectionEnvironmentName,
  connectionProjectName,
  connectionSourceName,
  loadConnections,
} from "./store/connections";
import { listNamespaces, Namespace } from "./api/nacos";
import { useTranslation } from "./i18n";
import ConnectionManager from "./components/ConnectionManager";
import ConfigBrowser from "./components/ConfigBrowser";
import CopyButton from "./components/CopyButton";
import DiffView from "./components/DiffView";
import About from "./components/About";
import Select from "./components/Select";
import Toaster from "./components/Toaster";
import SettingsView from "./components/SettingsView";
import SSHManagerView from "./components/SSHManagerView";
import ErrorDialog from "./components/ErrorDialog";
import MessageCenter from "./components/MessageCenter";
import BackupView, { type BackupDiffJumpParams } from "./components/BackupView";
import TaskCenter from "./components/TaskCenter";
import LogViewer from "./components/LogViewer";
import StartupDialog from "./components/StartupDialog";
import ApplyPlanView from "./components/ApplyPlanView";
import type { WorkflowStepId } from "./components/DiffWorkflowCard";
import { reportError, reportMessage } from "./lib/errorCenter";
import { connectionLabel, localizeDefaultName } from "./lib/defaultNameCopy";
import { closeAllPopovers } from "./lib/popoverBus";
import { useMountOnceVisible } from "./lib/keepAlive";
import { useBlockNativeSaveShortcut } from "./lib/saveShortcut";
import { useBlockNativeReloadShortcut } from "./lib/reloadShortcut";
import { consumeAppDataDocNotice } from "./lib/appDataDoc";
import { isComparableReleaseVersion } from "./lib/appVersion";
import { checkForUpdates, getAppInfo } from "./api/app";
import { loadSettings, updateStartupSettings, updateUpdateSettings } from "./store/settings";
import AuditView from "./components/AuditView";
import OperationHistoryView from "./components/OperationHistoryView";
import type { DiffJumpParams } from "./components/AuditView";
import { buildSnapshotConnection, mergeSnapshotRuntimeConnection } from "./lib/snapshotConnection";
import { toast } from "./lib/toast";
import { hasExistingStartupData, startupDialogKind, type StartupDialogKind } from "./lib/startupDialog";
import { recordOperation } from "./store/operationHistory";
import { applyEntryReturnMode, type ApplyEntryPayload } from "./lib/applyEntry";
import { errorText } from "./lib/errorText";
import { statusMessageProps } from "./lib/statusSemantics";

type NavigableMode = "browse" | "diff" | "connections" | "ssh" | "audit" | "history" | "backup" | "tasks" | "logviewer" | "settings" | "about";
type Mode = NavigableMode | "apply";

const navIconPath: Record<NavigableMode, string[]> = {
  browse: ["M4 5h16", "M4 10h16", "M4 15h10", "M4 20h8"],
  diff: ["M6 4v5c0 2 1 3 3 3h6", "M6 20v-5c0-2 1-3 3-3h6", "M15 8l4 4-4 4"],
  connections: ["M5 5h9v6H5z", "M10 11v4", "M10 18h4", "M17 15h2a2 2 0 012 2v1a2 2 0 01-2 2h-2a2 2 0 01-2-2v-1a2 2 0 012-2z", "M7 8h5"],
  ssh: ["M5 12h5", "M14 12h5", "M10 8l4 4-4 4", "M6 7a3 3 0 100 6 3 3 0 000-6z", "M18 11a3 3 0 100 6 3 3 0 000-6z"],
  audit: ["M4 5h16v14H4z", "M4 10h16", "M9 5v14", "M15 5v14"],
  history: ["M12 8v4l3 3", "M12 22a10 10 0 100-20 10 10 0 000 20z"],
  backup: [
    "M5 7c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z",
    "M5 7v8c0 1.7 3.1 3 7 3s7-1.3 7-3V7",
    "M5 11c0 1.7 3.1 3 7 3s7-1.3 7-3",
    "M16 17l3 3",
    "M19 17l-3 3",
  ],
  tasks: ["M5 7l2 2 4-4", "M13 8h6", "M5 16l2 2 4-4", "M13 17h6"],
  logviewer: ["M5 3h14v18H5z", "M9 7h6", "M9 11h6", "M9 15h4"],
  settings: ["M5 7h14", "M5 12h14", "M5 17h14", "M9 5v4", "M15 10v4", "M11 15v4"],
  about: ["M12 11v6", "M12 7h.01", "M12 22a10 10 0 100-20 10 10 0 000 20z"],
};

function NavIcon({ mode }: { mode: NavigableMode }) {
  return (
    <svg className="side-icon" viewBox="0 0 24 24" aria-hidden="true">
      {navIconPath[mode].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

interface UIState {
  connId?: string;
  mode?: string;
  sidebarCollapsed?: boolean;
  browseProject?: string;
  browseEnvironment?: string;
  browseSourceId?: string;
  // 轮45 R02：这里刻意没有 diffAutoCompare —— 「这一次要比」是一次性意图，不是状态。
  // 轮46 R01：这里也刻意没有 diffLeft*/diffRight* —— 「比的是哪一对」是状态，它唯一的主人是
  // cs.diffViewPreferences（DiffView 每次改动都写、挂载时自己恢复）。
  // 探针实测过双写代价：cs.ui 那份镜像只有发生过跳转才更新，于是它常年是旧的；重启时旧的赢下界面，
  // 还会被 DiffView 的保存 effect 抄回 prefs ⇒ 用户真正比过的那一对一次重启就永久丢失。
  // 读侧删键 = 忽略老数据里的这些键，不迁移、不报错，下次整对象回写自然带走。
}

const UI_KEY = "cs.ui";
function loadUI(): UIState {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY) || "{}");
  } catch {
    return {};
  }
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

/**
 * 回落判据的最小输入：「此刻在哪个项目 / 环境 / 来源」三格。
 * 轮47：不再把整个 UIState 传进来——那是存储的形状，含 mode、sidebarCollapsed 这些与回落无关的字段，
 * 传它等于暗示调用方「去存储里找答案」，而存储恰恰是这里唯一不能读的东西。
 */
interface ScopeHint {
  sourceId: string;
  project: string;
  environment: string;
}

function scopeHintFromUI(ui: UIState): ScopeHint {
  return {
    sourceId: ui.browseSourceId || ui.connId || "",
    project: ui.browseProject ?? "",
    environment: ui.browseEnvironment ?? "",
  };
}

function preferredConnection(connections: Connection[], hint: ScopeHint): Connection | undefined {
  const direct = connections.find((conn) => conn.id === hint.sourceId);
  if (direct) return direct;
  const project = hint.project?.trim();
  const environment = hint.environment?.trim();
  if (project && environment) {
    return connections.find((conn) => connectionProjectName(conn) === project && connectionEnvironmentName(conn) === environment);
  }
  if (project) return connections.find((conn) => connectionProjectName(conn) === project);
  return connections[0];
}

function preferredSource(connections: Connection[]): Connection | undefined {
  return connections.find((conn) => conn.isDefaultSource) ?? connections[0];
}

function isNavigableMode(mode: string | undefined): mode is NavigableMode {
  switch (mode) {
    case "browse":
    case "diff":
    case "connections":
    case "ssh":
    case "audit":
    case "history":
    case "backup":
    case "tasks":
    case "logviewer":
    case "settings":
    case "about":
      return true;
    default:
      return false;
  }
}

function applyReturnMode(payload: ApplyEntryPayload): NavigableMode {
  // 落点判据收在 applyEntry.ts：计划页的步骤条按同一个答案决定能不能点（轮76）。
  const mode = applyEntryReturnMode(payload);
  return isNavigableMode(mode) ? mode : "browse";
}

function snapshotCompareNamespace(params: BackupDiffJumpParams): string {
  return params.snapshot.source.namespace || params.snapshot.source.namespaceId || "public";
}

function snapshotCompareResourceName(params: BackupDiffJumpParams): string {
  return params.snapshot.name || params.snapshot.id;
}

export default function App() {
  const { t } = useTranslation();
  // Ctrl/Cmd+S 不该被 webview 的原生「保存网页」对话框接走（R47）：
  // 编辑区里由 CodeEditor 的 onSave 接管，其余位置由这条兜底统一吞掉。
  useBlockNativeSaveShortcut();
  // F5 / Ctrl+R 不该被 webview 的原生重载接走（轮45 R01）：这是桌面应用，整页刷新会把
  // 只活在内存里的现场一次清空（实测：浏览页的搜索词与 2 条结果、打开的详情，刷新后 0 命中），
  // 而应用本身没有「刷新」这个动作——真要重载走工具栏/菜单，或带 Alt 的组合（判据放行）。
  useBlockNativeReloadShortcut();
  const [connections, setConnections] = useState<Connection[]>(() => loadConnections());
  // 轮47 R47-02：cs.ui 只在挂载时读一次。渲染体里读存储不是「浪费一次解析」这么简单——
  // 读回来的到底是用户现场、还是本应用上一帧写进去的回声，代码上无法判定（轮45/轮46 同一个根因）。
  const [ui0] = useState(() => loadUI());
  const [activeConnId, setActiveConnId] = useState<string>(() => preferredConnection(connections, scopeHintFromUI(ui0))?.id ?? "");
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [nsLoading, setNsLoading] = useState(false);
  const [nsError, setNsError] = useState<string | null>(null);
  const [tenant, setTenant] = useState<string>("");
  const [tenantFollowsDefault, setTenantFollowsDefault] = useState(true);
  const knownMode = isNavigableMode(ui0.mode) ? ui0.mode : "browse";
  const initialMode = connections.length === 0 && (knownMode === "browse" || knownMode === "diff") ? "connections" : knownMode;
  const [mode, setMode] = useState<Mode>(initialMode);
  // 轮46 R02：「上一轮退出时停在对比页」是一次性意图，交给 DiffView 结合 prefs 里那一对决定要不要直接比出来。
  // 必须用 useState 初值取一次：直接把 initialMode === "diff" 的判断散在渲染里，会把
  // 「本会话中途点进对比页」也点亮它，退化成轮45 刚清掉的那种回声室（每次挂载白比一轮）。
  const [autoCompareOnRestore] = useState(() => initialMode === "diff");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(!!ui0.sidebarCollapsed);
  // 轮47 R47-01：回落唯一允许的数据源——React 自己记住的「最后一个有效来源」的作用域，
  // 初值取挂载快照。删除当前来源的那一帧 activeConn 已经是 null，下面的刷新 effect 不覆盖它，
  // 于是 ref 里留下的正是刚被删那条的项目/环境 ⇒ 回落在同环境里找兄弟，而不是跳到列表第 0 条。
  const lastValidScopeRef = useRef<ScopeHint>(scopeHintFromUI(ui0));
  const [runtimeSnapshotConnections, setRuntimeSnapshotConnections] = useState<Connection[]>([]);
  const [appVersion, setAppVersion] = useState("");
  const [startupDialog, setStartupDialog] = useState<StartupDialogKind | null>(null);
  const [pendingApplyEntry, setPendingApplyEntry] = useState<ApplyEntryPayload | null>(null);
  // stepper 导航回退到对比页时的聚焦提示
  const [diffFocusStep, setDiffFocusStep] = useState<WorkflowStepId | null>(null);
  // 变更计划页半截写入后跳来操作历史时要定位的记录（轮66 WP-2）：只由跳转写入，历史页消费完即清。
  const [historyFocusRecordId, setHistoryFocusRecordId] = useState<string | null>(null);
  // 关于页的到达定位（轮74 D2）：设置页「检查更新」与新版本提醒都指向「应用更新」这一节，
  // 只由跳转写入，关于页消费完即清 —— 下次从导航栏进关于页不该再闪一下。
  const [aboutArriveAtUpdate, setAboutArriveAtUpdate] = useState(false);
  /**
   * 进关于页看更新（轮74 D2）：设置页那颗按钮与消息中心的新版本提醒共用这一个出口。
   *
   * 为什么不由关于页自己判「我是被谁叫起来的」：那样要么每次挂载都闪一下（从导航栏进也闪），
   * 要么谁都闪不到。标记留在跳转发起方，与 diffFocusStep / historyFocusRecordId 同一形状——
   * 一次性意图只活在 props 里，不进任何存储。useCallback 是为了让后台检查那条 effect 能把它写进依赖。
   */
  const openAboutAtUpdate = useCallback(() => {
    setAboutArriveAtUpdate(true);
    setMode("about");
  }, []);
  // 自增即重新拉取命名空间（用于「重试」）。
  const [nsReload, setNsReload] = useState(0);
  // 跨视图导航参数（BackupView / AuditView → DiffView）。轮46：只由跳转设置，
  // 启动恢复不再走这条路（来源与「要不要比」都由 DiffView 从 prefs 自己判定）。
  const [diffInitialParams, setDiffInitialParams] = useState<DiffJumpParams | null>(null);

  const activeConn = connections.find((c) => c.id === activeConnId) ?? null;
  const diffConnections = useMemo(
    () => [...connections, ...runtimeSnapshotConnections.filter((conn) => !connections.some((item) => item.id === conn.id))],
    [connections, runtimeSnapshotConnections]
  );

  useEffect(() => {
    let alive = true;
    const hasExistingAppData = hasExistingStartupData();
    const applyVersion = (version: string) => {
      if (!alive) return;
      setAppVersion(version);
      const settings = loadSettings();
      const kind = startupDialogKind({ currentVersion: version, settings, hasExistingAppData });
      setStartupDialog(kind);
      if (!kind) {
        updateStartupSettings({ lastOpenedVersion: version });
      }
    };

    getAppInfo()
      .then((info) => applyVersion(info.version || "dev"))
      .catch(() => applyVersion("dev"));

    return () => {
      alive = false;
    };
  }, []);

  // 主数据文件引导提示：迁移导入 / 从文件恢复 / 损坏回退。
  // 轮94 口径：这三类都是「用户没有等它的时刻」发生的系统自发事件，落点是登记簿而不是即时通道——
  // 以前「已恢复 N 条连接」只有一条 2.6 秒的 toast，错过就再也无从知道本次数据是从哪一份来的；
  // 而它恰恰只在清缓存 / 换 profile 这类一次性场景出现，正是最该留痕的一类。
  // 损坏回退是坏事（error），按口径仍要即时播报一句；恢复与导入是好消息（info），只留未读角标。
  useEffect(() => {
    const notice = consumeAppDataDocNotice();
    if (!notice) return;
    if (notice.kind === "corrupt-fallback") {
      reportMessage({
        level: "error",
        origin: "system",
        title: t("app.dataFileCorruptTitle"),
        source: t("app.dataFileSource"),
        message: t("app.dataFileCorruptMessage", { file: notice.detail }),
      });
      return;
    }
    const restored = notice.kind === "restored-from-file";
    reportMessage({
      level: "info",
      origin: "system",
      title: t(restored ? "app.dataFileRestoredTitle" : "app.dataFileImportedTitle"),
      source: t("app.dataFileSource"),
      message: t(restored ? "app.dataFileRestored" : "app.dataFileImported", { count: notice.connections }),
    });
  }, [t]);

  // 记住上次的连接、浏览筛选与模式。
  useEffect(() => {
    const persistedMode = mode === "apply" ? (pendingApplyEntry ? applyReturnMode(pendingApplyEntry) : "browse") : mode;
    const activeConnection = connections.find((conn) => conn.id === activeConnId);
    localStorage.setItem(
      UI_KEY,
      JSON.stringify({
        connId: activeConnId,
        mode: persistedMode,
        sidebarCollapsed,
        browseProject: activeConnection ? connectionProjectName(activeConnection) : "",
        browseEnvironment: activeConnection ? connectionEnvironmentName(activeConnection) : "",
        browseSourceId: activeConnection?.id ?? "",
      })
    );
  }, [activeConnId, connections, mode, pendingApplyEntry, sidebarCollapsed]);

  // 模式切换即收起所有自绘下拉/候选弹层：它们的菜单 portal 到 document.body，
  // 不在被保活隐藏的页面子树里，光给容器加 hidden 关不掉（见 lib/popoverBus）。
  useEffect(() => {
    closeAllPopovers();
  }, [mode]);

  // 启动后低频后台检查更新（延迟 5 分钟，仅一次）
  useEffect(() => {
    const settings = loadSettings();
    const lastCheck = settings.update.lastCheckAt ? new Date(settings.update.lastCheckAt).getTime() : 0;
    const hoursSince = (Date.now() - lastCheck) / 3600000;
    if (hoursSince < 6) return; // 6 小时内不重复检查
    const timer = setTimeout(
      async () => {
        try {
          const info = await getAppInfo();
          // 未注入版本号的构建（appVersion 还是 dev 或裸 sha）在 Go 侧被解析成 0.0.0，
          // 后台检查就会永远报「有新版本」，即使装的正是最新版（轮51 的线上事故形态）。
          // 版本号不可比 ≠ 版本很旧：这里直接不发请求，关于页的手动检查不受影响。
          if (!isComparableReleaseVersion(info.version)) return;
          const result = await checkForUpdates({
            currentVersion: info.version,
            sources: info.updateSources,
            proxy: settings.proxy,
          });
          updateUpdateSettings({
            lastCheckAt: new Date().toISOString(),
            lastSeenVersion: result.latestVersion || "",
          });
          if (!result.hasUpdate || result.error) return;
          if (!result.mandatory && settings.update.skipVersion === result.latestVersion) return;
          // 系统自发的好消息（用户没点过「检查更新」）：只登记，不占即时通道（轮94 口径）。
          reportMessage({
            level: "info",
            origin: "system",
            title: t("about.updateAvailable", { version: result.latestVersion }),
            source: t("about.updateTitle"),
            message: result.releaseNotes || "",
            actionLabel: t("about.openDownload"),
            onAction: openAboutAtUpdate,
          });
        } catch {
          // 后台检查失败静默忽略
        }
      },
      5 * 60 * 1000
    );
    return () => clearTimeout(timer);
  }, [openAboutAtUpdate, t]);

  // 记住此刻所在的作用域。必须声明在下面的回落 effect 之前：回落只认这份内存里的记忆，
  // 而持久化 effect（也声明在前）在 activeConn 为空时会把 cs.ui 的 browse* 写成空串——
  // 实测过读它的下场：三层判据全废，选中项跨环境跳到 connections[0]。
  useEffect(() => {
    if (!activeConn) return;
    lastValidScopeRef.current = {
      sourceId: activeConn.id,
      project: connectionProjectName(activeConn),
      environment: connectionEnvironmentName(activeConn),
    };
  }, [activeConn]);

  // 连接列表变化后，确保 activeConnId 有效
  useEffect(() => {
    if (connections.length === 0) {
      setActiveConnId("");
    } else if (!connections.some((c) => c.id === activeConnId)) {
      setActiveConnId(preferredConnection(connections, lastValidScopeRef.current)?.id ?? connections[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections]);

  // 切换连接：重置命名空间并拉取
  useEffect(() => {
    if (!activeConn) {
      setNamespaces([]);
      setTenant("");
      setTenantFollowsDefault(true);
      return;
    }
    let alive = true;
    setNsLoading(true);
    setNsError(null);
    listNamespaces(activeConn)
      .then((ns) => alive && setNamespaces(ns))
      .catch((e) => {
        if (!alive) return;
        const message = errorText(e);
        setNsError(message);
        setNamespaces([]);
        reportError({
          title: t("app.namespaceLoadFailed"),
          source: connectionLabel(activeConn, t),
          message,
          detail: message,
          actionLabel: t("common.retry"),
          onAction: () => setNsReload((x) => x + 1),
        });
      })
      .finally(() => alive && setNsLoading(false));
    return () => {
      alive = false;
    };
  }, [activeConn, nsReload, t]);

  useEffect(() => {
    setTenantFollowsDefault(true);
  }, [activeConnId]);

  useEffect(() => {
    if (!activeConn || !tenantFollowsDefault) return;
    setTenant(activeConn.defaultNamespace || "");
  }, [activeConn, activeConnId, tenantFollowsDefault]);

  const navGroups: { group: string; label: string; items: { mode: NavigableMode; label: string }[] }[] = [
    {
      group: "config",
      label: t("app.navGroupConfig"),
      items: [
        { mode: "browse", label: t("app.title") },
        { mode: "diff", label: t("app.diff") },
        { mode: "audit", label: t("app.audit") },
      ],
    },
    {
      group: "data",
      label: t("app.navGroupData"),
      items: [
        { mode: "history", label: t("app.history") },
        { mode: "backup", label: t("app.backup") },
        { mode: "tasks", label: t("app.tasks") },
        { mode: "logviewer", label: t("app.logViewer") },
      ],
    },
    {
      group: "system",
      label: t("app.navGroupSystem"),
      items: [
        { mode: "connections", label: t("app.connectionManage") },
        { mode: "ssh", label: t("app.sshTunnels") },
        { mode: "settings", label: t("app.settings") },
        { mode: "about", label: t("app.about") },
      ],
    },
  ];

  const navigateBackupToDiff = (params: BackupDiffJumpParams) => {
    const recordSnapshotCompare = (result: "success" | "failure", error?: string) => {
      recordOperation({
        type: "snapshot_compare",
        result,
        connectionId: params.sourceConnectionId,
        connectionName: params.sourceConnectionName,
        namespace: snapshotCompareNamespace(params),
        group: params.group,
        dataId: params.dataId,
        content: params.snapshotPath || params.snapshot.path || "",
        rollbackable: false,
        rollbackReason: "operationHistory.rollbackSnapshotOnly",
        resourceId: params.snapshot.id,
        resourceName: snapshotCompareResourceName(params),
        ...(error ? { error } : {}),
      });
    };

    const sourceConnection = connections.find((conn) => conn.id === params.sourceConnectionId);
    if (!sourceConnection) {
      const message = t("backup.sourceConnectionMissing");
      recordSnapshotCompare("failure", message);
      reportError({
        title: t("backup.compareUnavailable"),
        source: params.sourceConnectionName,
        message,
        detail: JSON.stringify(params.snapshot, null, 2),
      });
      return;
    }
    if (!params.snapshot.path) {
      const message = t("backup.snapshotPathMissing");
      recordSnapshotCompare("failure", message);
      reportError({
        title: t("backup.compareUnavailable"),
        source: params.snapshot.name || params.snapshot.id,
        message,
        detail: JSON.stringify(params.snapshot, null, 2),
      });
      return;
    }

    const snapshotConnection = buildSnapshotConnection(params.snapshot, sourceConnection);
    setRuntimeSnapshotConnections((current) => mergeSnapshotRuntimeConnection(current, snapshotConnection));
    setDiffInitialParams({
      leftConnId: snapshotConnection.id,
      rightConnId: params.sourceConnectionId,
      // 两侧都是同一逻辑配置，namespace/group/dataId 相同，但左右连接各自的存储独立，
      // 必须显式传两侧，避免 DiffView 用左连接命名空间去右连接取数
      left: { tenant: params.namespace, group: params.group, dataId: params.dataId },
      right: { tenant: params.namespace, group: params.group, dataId: params.dataId },
      autoCompare: true,
    });
    setMode("diff");
    toast(t("backup.comparePrepared"), "info");
    recordSnapshotCompare("success");
  };

  const startApply = (payload: ApplyEntryPayload) => {
    setPendingApplyEntry(payload);
    setMode("apply");
  };

  /**
   * 半截写入后的回退出口（轮66 WP-2）：带着本次记录 id 去操作历史。
   * 这颗按钮只出现在执行已收口的失败态，不存在在途写入，所以不必走计划页
   * 「执行中别离开」那道确认（attemptBack）；离开时计划页卸载，回不去第 5 步是既成事实，
   * 但历史页那条记录本身就带着错误详情与备份快照回退入口，比留在原地更管用。
   */
  const openHistoryAtRecord = (recordId: string) => {
    setHistoryFocusRecordId(recordId);
    setMode("history");
  };

  const applyReturnTarget = pendingApplyEntry ? applyReturnMode(pendingApplyEntry) : "browse";

  // 配置对比保活范围（轮44 R1 / D3）：与 .browse-cache 同构——第一次进对比页才挂载，
  // 之后切到任何模式都只是 hidden，刚跑完的差异结果、来源选择、滚动位置都留在内存里。
  // 改造前它只在 diff↔apply 之间活着（渲染条件写在下面的模式分支里），绕一下配置浏览再回来
  // 结果就没了：探针实测可见 .diff-row 60 → 0，还白付 8 次取数（整棵子树重新挂载重新拉）。
  // 常驻挂载的代价由 DiffView 的 active 闸门挡住：隐藏期不取数、不报错、不聚焦。
  const diffVisible = mode === "diff" || (mode === "apply" && applyReturnTarget === "diff");
  const diffMounted = useMountOnceVisible(diffVisible);

  const closeStartupDialog = () => {
    if (!startupDialog || !appVersion) return;
    updateStartupSettings({
      lastOpenedVersion: appVersion,
      ...(startupDialog === "welcome" ? { lastShownWelcomeVersion: appVersion } : { lastShownChangelogVersion: appVersion }),
    });
    setStartupDialog(null);
  };

  const browseProjects = uniqueSorted(connections.map((conn) => connectionProjectName(conn)));
  const activeProject = activeConn ? connectionProjectName(activeConn) : (browseProjects[0] ?? "");
  const browseProjectConnections = connections.filter((conn) => connectionProjectName(conn) === activeProject);
  const browseEnvironments = uniqueSorted(browseProjectConnections.map((conn) => connectionEnvironmentName(conn)));
  const activeEnvironment =
    activeConn && connectionProjectName(activeConn) === activeProject
      ? connectionEnvironmentName(activeConn)
      : (browseEnvironments[0] ?? "");
  const browseEnvironmentConnections = browseProjectConnections.filter((conn) => connectionEnvironmentName(conn) === activeEnvironment);
  const activeSourceId = browseEnvironmentConnections.some((conn) => conn.id === activeConnId)
    ? activeConnId
    : (preferredSource(browseEnvironmentConnections)?.id ?? "");
  const sourceNameCounts = browseEnvironmentConnections.reduce<Record<string, number>>((acc, conn) => {
    const name = connectionSourceName(conn);
    acc[name] = (acc[name] ?? 0) + 1;
    return acc;
  }, {});
  const browseSourceOptions = browseEnvironmentConnections.map((conn) => {
    const sourceName = connectionSourceName(conn);
    const duplicated = sourceNameCounts[sourceName] > 1;
    return {
      value: conn.id,
      label: duplicated ? `${localizeDefaultName(sourceName, t)} · ${conn.name}` : localizeDefaultName(sourceName, t),
    };
  });
  const selectBrowseProject = (project: string) => {
    const nextConnections = connections.filter((conn) => connectionProjectName(conn) === project);
    const next = preferredSource(nextConnections);
    if (next) setActiveConnId(next.id);
  };
  const selectBrowseEnvironment = (environment: string) => {
    const nextConnections = browseProjectConnections.filter((conn) => connectionEnvironmentName(conn) === environment);
    const next = preferredSource(nextConnections);
    if (next) setActiveConnId(next.id);
  };

  const browsePage = (
    <div className="page-surface browse-page">
      <div className="page-header">
        <div>
          <h3>{t("app.title")}</h3>
          <div className="page-subtitle">{activeConn ? connectionLabel(activeConn, t) : t("app.selectConnection")}</div>
        </div>
        <div className="page-actions browse-scope-bar">
          <div className="browse-scope-field">
            <span>{t("connection.project")}</span>
            <Select
              value={activeProject}
              disabled={connections.length === 0}
              title={t("connection.project")}
              options={browseProjects.map((project) => ({ value: project, label: localizeDefaultName(project, t) }))}
              onChange={selectBrowseProject}
            />
          </div>
          <div className="browse-scope-field">
            <span>{t("connection.environment")}</span>
            <Select
              value={activeEnvironment}
              disabled={browseProjectConnections.length === 0}
              title={t("connection.environment")}
              options={browseEnvironments.map((environment) => ({ value: environment, label: localizeDefaultName(environment, t) }))}
              onChange={selectBrowseEnvironment}
            />
          </div>
          <div className="browse-scope-field">
            <span>{t("app.source")}</span>
            <Select
              value={activeSourceId}
              disabled={browseEnvironmentConnections.length === 0}
              title={t("app.source")}
              options={browseSourceOptions}
              onChange={setActiveConnId}
            />
          </div>
          <div className="browse-scope-field namespace">
            <span>{t("app.namespace")}</span>
            <Select
              value={tenant}
              disabled={!activeConn || nsLoading}
              title={t("app.namespace")}
              options={[
                { value: "", label: nsLoading ? t("app.namespaceLoading") : t("app.namespaceDefault") },
                ...namespaces
                  .filter((n) => n.namespace)
                  .map((n) => ({
                    value: n.namespace,
                    label: `${n.namespaceShowName || n.namespace}（${n.configCount}）`,
                  })),
              ]}
              onChange={(value) => {
                setTenant(value);
                setTenantFollowsDefault(false);
              }}
            />
          </div>
        </div>
      </div>
      {!activeConn ? (
        <div className="pad-msg big">{t("app.selectConnection")}</div>
      ) : nsError ? (
        <div className="pad-msg big err" {...statusMessageProps("error")}>
          {t("app.cannotConnect", { name: activeConn.name })}
          <div className="diff-hint">{nsError}</div>
          <div className="err-actions">
            <button className="btn btn-primary" onClick={() => setNsReload((x) => x + 1)}>
              {t("common.retry")}
            </button>
            <button className="btn btn-ghost" onClick={() => setMode("connections")}>
              {t("app.connectionManage")}
            </button>
            <CopyButton text={nsError} label={t("diff.copyError")} />
          </div>
        </div>
      ) : (
        <ConfigBrowser
          key={`${activeConnId}:${tenant}`}
          conn={activeConn}
          tenant={tenant}
          connections={connections}
          onStartApply={startApply}
          active={mode === "browse"}
        />
      )}
    </div>
  );

  const diffPage = (
    <DiffView
      active={mode === "diff"}
      connections={diffConnections}
      onConnectionsChange={setConnections}
      initialParams={diffInitialParams}
      onInitialParamsConsumed={() => setDiffInitialParams(null)}
      onStartApply={startApply}
      focusStep={diffFocusStep}
      onFocusStepConsumed={() => setDiffFocusStep(null)}
      autoCompareOnRestore={autoCompareOnRestore}
    />
  );
  return (
    // 全局关掉拼写检查：HTML 的 spellcheck 会向后代继承，配置正文、dataId、IP、
    // 密钥这类内容不该被红线标成「拼写错误」；个别输入框另有显式声明兜底（守卫见 tests/ux）。
    <div className="app-shell" spellCheck={false}>
      <div className="app-main">
        <aside className={`sidebar${sidebarCollapsed ? " collapsed" : ""}`}>
          {/* 侧栏是全站唯一的页面切换入口，读屏需要一个地标名（R41） */}
          <nav className="side-nav" aria-label={t("app.mainNav")}>
            {navGroups.map((group, groupIndex) => (
              <div key={group.group} className="side-nav-group">
                {groupIndex > 0 && <div className="side-nav-separator" />}
                {!sidebarCollapsed && <div className="side-nav-group-label">{group.label}</div>}
                {group.items.map((item) => (
                  <button
                    key={item.mode}
                    className={`side-nav-item${mode === item.mode ? " active" : ""}`}
                    /* 展开态也可能被截断（窄窗口/长译名），一律给全文；
                       aria-current 让读屏在进侧栏时就念出「当前页」，而不是只靠视觉高亮认（R41） */
                    title={item.label}
                    aria-current={mode === item.mode ? "page" : undefined}
                    onClick={() => setMode(item.mode)}
                  >
                    <NavIcon mode={item.mode} />
                    <span className="side-label">{item.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <MessageCenter collapsed={sidebarCollapsed} />
            <button
              className="sidebar-toggle"
              title={sidebarCollapsed ? t("app.expandSidebar") : t("app.collapseSidebar")}
              aria-label={sidebarCollapsed ? t("app.expandSidebar") : t("app.collapseSidebar")}
              aria-expanded={!sidebarCollapsed}
              onClick={() => setSidebarCollapsed((value) => !value)}
            >
              {sidebarCollapsed ? ">" : "<"}
            </button>
          </div>
        </aside>

        <main className="workspace">
          {/* 配置浏览保活（R8 / D3）：切到审计、历史、备份、设置等模式时，整页只是 hidden，不卸载。
              选中项、正文、搜索词、分组、列表滚动、CodeView 查找态都留在内存里，回来不再重发列表请求。
              连接 / 命名空间变化仍靠下面的 key 重挂载来重拉数据，行为与改造前一致。
              用 hidden 属性 + display:none 的兜底规则，而不是临时 class：
              子树内的弹层（modal-overlay 是 fixed 定位）跟着一起消失，且 Tab 不会穿过隐藏内容。
              唯一例外是 portal 到 document.body 的下拉菜单，它们不随容器 hidden 消失，
              由模式切换的 effect 统一收起（见 lib/popoverBus）。 */}
          {connections.length > 0 && (
            <div className="browse-cache" hidden={mode !== "browse"}>
              {browsePage}
            </div>
          )}
          {/* 配置对比保活层（轮44）：hidden 条件与浏览页同形。apply 态即使回程目标是 diff
              也必须藏着，否则计划页和看不见的对比页同时占一份布局。和浏览页一样用 hidden
              属性而不是临时 class：子树里的 fixed 弹层跟着消失，Tab 也不会穿过隐藏内容。 */}
          {connections.length > 0 && diffMounted && (
            <div className="diff-apply-cache" hidden={mode !== "diff"}>
              {diffPage}
            </div>
          )}
          {mode === "connections" ? (
            <ConnectionManager
              embedded
              onClose={() => setMode(connections.length ? "browse" : "connections")}
              onChange={(conns) => setConnections(conns)}
            />
          ) : mode === "audit" ? (
            <AuditView
              connections={connections}
              onNavigateToDiff={(params) => {
                setDiffInitialParams(params);
                setMode("diff");
              }}
              onStartApply={startApply}
            />
          ) : mode === "history" ? (
            <OperationHistoryView
              connections={connections}
              onStartApply={startApply}
              focusRecordId={historyFocusRecordId}
              onFocusConsumed={() => setHistoryFocusRecordId(null)}
            />
          ) : mode === "backup" ? (
            <BackupView onNavigateToDiff={navigateBackupToDiff} onStartApply={startApply} />
          ) : mode === "tasks" ? (
            <TaskCenter />
          ) : mode === "logviewer" ? (
            <LogViewer />
          ) : mode === "ssh" ? (
            <SSHManagerView connections={connections} />
          ) : mode === "settings" ? (
            <SettingsView onOpenAbout={openAboutAtUpdate} />
          ) : mode === "about" ? (
            <About embedded arriveAtUpdate={aboutArriveAtUpdate} onArriveConsumed={() => setAboutArriveAtUpdate(false)} />
          ) : mode === "apply" ? (
            <ApplyPlanView
              entry={pendingApplyEntry}
              connections={diffConnections}
              onOpenHistory={openHistoryAtRecord}
              onStartApply={startApply}
              onBack={(focusStep) => {
                // 只有回程目标是 diff 才递聚焦步：对比页现在常驻挂载，focusStep 落到
                // 看不见的那一棵 = 替别的页面抢焦点（DiffView 里另有 active 闸门兜底）。
                if (applyReturnTarget === "diff") setDiffFocusStep(focusStep ?? null);
                setMode(applyReturnTarget);
              }}
            />
          ) : connections.length === 0 ? (
            <div className="pad-msg big">
              {t("app.noConnection")}
              <button className="btn btn-primary" onClick={() => setMode("connections")}>
                {t("app.addConnection")}
              </button>
            </div>
          ) : null}
        </main>
      </div>

      <Toaster />
      <ErrorDialog />
      {startupDialog && appVersion && <StartupDialog kind={startupDialog} version={appVersion} onClose={closeStartupDialog} />}
    </div>
  );
}
