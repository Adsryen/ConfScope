import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n";
import { countMigratableStoredCredentials, migrateStoredCredentials, type CredentialMigrationSummary } from "../lib/credentialSecrets";
import { clearAppCache } from "../lib/cacheCleanup";
import { resetConfigRevisionAccelerator } from "../lib/configRevisions";
import { formatDateTime } from "../lib/formatDateTime";
import { formatBytes } from "../lib/formatBytes";
import { getAppDataDocInfo, type AppDataDocInfo } from "../lib/appDataDoc";
import { loadAppDataBackupState } from "../store/appDataBackup";
import { clearOperationHistory } from "../store/operationHistory";
import {
  loadSettings,
  saveSettings,
  type AppSettings,
  type CompareSettings,
  type ProxySettings,
  type StartupSettings,
  type UpdateSettings,
} from "../store/settings";
import { useSettings } from "../lib/useSettings";
import { toast } from "../lib/toast";
import { PROXY_FIELDS, isSameProxy, readProxyField, type ProxyField, type ProxyIssue } from "../lib/proxySettings";
import AppDataBackupPanel from "./AppDataBackupPanel";
import ConfirmModal from "./ConfirmModal";
import CopyButton from "./CopyButton";
import InlineError from "./InlineError";
import {
  CheckDataRootRollback,
  ClearConfigRevisions,
  GetDataLocations,
  GetConfigRevisionFacts,
  GetRuntimeLayout,
  MigrateDataRoot,
  OpenDataFolder,
  PlanDataRootMigration,
  RollbackDataRoot,
  SelectDataRootDirectory,
  type ConfigRevisionFacts,
  type DataLocations,
  type DataRootRollbackStatus,
  type RuntimeLayoutInfo,
} from "../../wailsjs/go/app/App";
import LanguageSwitch from "./LanguageSwitch";
import { moveRailFocus, useSectionSpy } from "../lib/sectionSpy";
import { useWheelColumnResolver, useWheelSurface } from "../lib/useWheelColumnResolver";
import { useScrollMemory } from "../lib/viewState";
import { errorText } from "../lib/errorText";
import { statusMessageProps } from "../lib/statusSemantics";
import { useKeepVisible } from "../lib/useKeepVisible";

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

/*
 * 设置补丁（轮73 R73-I4）：四个嵌套段只给要改的那一个字段。
 * 原先调用方写 update({ compare: { ...settings.compare, sortConnections: v } })——展开的是**渲染闭包**里
 * 那份 settings，而 update 内部的合并基准是盘上的 loadSettings()。同一次交互里连着写两段时
 * （代理框失焦提交 + 立刻动开关，React 还没重渲染），后一次的闭包是旧的，会把前一次刚写进去的
 * 兄弟字段整片吃回去。段级合并收在 update 一处，调用方不再有机会带旧值。
 */
type SettingsPatch = Omit<Partial<AppSettings>, "proxy" | "update" | "compare" | "startup"> & {
  proxy?: Partial<ProxySettings>;
  update?: Partial<UpdateSettings>;
  compare?: Partial<CompareSettings>;
  startup?: Partial<StartupSettings>;
};

/** 数据根命中档位的展示标签键（Go 侧 RootSource 的稳定字面量，逐档一条 i18n）。 */
const DATA_ROOT_SOURCE_KEYS: Record<string, string> = {
  env: "settings.dataRootSourceEnv",
  "user-choice": "settings.dataRootSourceUserChoice",
  "install-marker": "settings.dataRootSourceInstallMarker",
  "legacy-adoption": "settings.dataRootSourceLegacyAdoption",
  "exe-adjacent": "settings.dataRootSourceExeAdjacent",
  "os-user-data": "settings.dataRootSourceOsUserData",
};

/*
 * 代理三框的标签、示例与报错文案（轮72 R-B2）。
 *
 * 三框共用一段渲染，差别只有这三张表。原来三份手写 JSX 里连 placeholder 都是同一条
 * `http://127.0.0.1:7890`：HTTPS 代理框提示 7890、「不走代理」框也提示一个地址，
 * 用户照着示例填 —— 填进去的正是 Go 侧认不得、静默不生效的那种值。
 */
const PROXY_LABEL_KEYS: Record<ProxyField, string> = {
  httpProxy: "settings.httpProxy",
  httpsProxy: "settings.httpsProxy",
  noProxy: "settings.noProxy",
};
const PROXY_PLACEHOLDERS: Record<ProxyField, string> = {
  httpProxy: "http://127.0.0.1:7890",
  httpsProxy: "http://proxy.example.com:3128",
  noProxy: "localhost,127.0.0.1,.internal",
};
const PROXY_ISSUE_KEYS: Record<ProxyIssue, string> = {
  url: "settings.proxyErrorUrl",
  noProxyItem: "settings.proxyErrorNoProxyItem",
};

interface SettingsViewProps {
  /**
   * 「检查更新」与下载/安装整套动作都在关于页（About）里，设置页不复制第二份检查逻辑：
   * 这颗键只把用户送到那一页（轮72 R-B6）。原先设置页的「应用更新」一节只读不回，
   * 用户在这儿看完「上次检查：三天前」只能自己回想关于页在哪儿。
   */
  onOpenAbout: () => void;
}

export default function SettingsView({ onOpenAbout }: SettingsViewProps) {
  const { t } = useTranslation();
  // 关闭键与全局轻提示共用 common.close（轮67 R67-WP7）：两处都是「这条我看完了」，
  // 不该有第二种念法；不新增文案键。
  const closeLabel = t("common.close");
  // 设置读侧走 lib/useSettings 那一份出口（轮47 R47-04）：本页原先自己攥一份 state + 自己读盘，
  // About 写完 skipVersion 后回到设置页看到的是旧值，得切走再切回才刷新。
  const settings = useSettings();
  const [saved, setSaved] = useState(false);
  /*
   * 「设置已保存」落在哪一节（轮73 R73-I2）：徽章原先只钉在页面头右上角，离被点的控件三百多像素，
   * 1.2s 就消失。现在由调用方点名——徽章画在刚被改动那一节的右上角。null = 调用方没给落点，
   * 退回工作区右上角，绝不出现「保存了但屏幕上没有任何回应」。
   */
  const [savedPanel, setSavedPanel] = useState<string | null>(null);
  const [credentialPending, setCredentialPending] = useState(() => countMigratableStoredCredentials());
  const [credentialSummary, setCredentialSummary] = useState<CredentialMigrationSummary | null>(null);
  const [credentialError, setCredentialError] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheResult, setCacheResult] = useState<"" | "ok" | "fail">("");
  /*
   * 清理缓存失败的原因（轮72 R-B1）：原先 catch 把异常整个丢掉，界面上只剩一句「清理缓存失败」，
   * 用户既不知道是什么被拦住了，也没法把那句话抄给别人——而这条失败通常是文件权限或磁盘。
   */
  const [cacheError, setCacheError] = useState("");
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
  // 本机版本历史（R57-WP14）：体量事实 + 独立清除入口的状态。
  const [revisionFacts, setRevisionFacts] = useState<ConfigRevisionFacts | null>(null);
  const [revisionBusy, setRevisionBusy] = useState(false);
  const [revisionResult, setRevisionResult] = useState<"" | "ok" | "fail">("");
  const [revisionError, setRevisionError] = useState("");
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
  /*
   * 切走再回设置页不丢阅读位置（轮67 R67-WP3c）：真机量过——面板滚到 800 → 去配置浏览 →
   * 回来 scrollTop=0，2762px 的内容每次都要从头找那一节。位置记在 lib/viewState 那份
   * 唯一的模块内存里（与审计/历史/备份同口径，不进浏览器持久存储：用户要的是切 Tab 不丢，
   * 不是重启还记得）。listVersion 给常量 0：8 节同屏渲染、挂载即有完整高度，
   * 不存在「列表还没到被夹回 0」那种要按条数再恢复一次的场景。
   * 传 panelsRef 进来：同一个容器还要喂给 scroll-spy，两处不能各攥一份。
   */
  const panelsScroll = useScrollMemory("settings.scroll.panels", 0, panelsRef);
  const { activeId, jumpToSection, releasePin } = useSectionSpy(panelsRef, SECTION_IDS);
  /*
   * 滚轮兜底（轮73 R73-I1 的另一半，改 CSS 只是必要条件不是充分条件）。
   * 左栏原先自己滚动（max-height + overflow-y:auto + overscroll-behavior:contain），删掉它之后
   * 实测仍然死：afterRail 0 / afterHead 600——因为左栏不是 .settings-panels 的子孙，浏览器顺着
   * 祖先链找不到任何可滚容器，这一格滚轮无处可去。全站 chrome 死区由 lib/useWheelColumnResolver
   * 那一份实现接管（按几何挑靶面、把滚轮档位换算成像素、夹界、写偏移），这里只登记两件事：
   * 「这一页要兜底」挂在 .settings-workbench（页头在它之外，与差异对比同一形状），
   * 「投给谁」递 panelsRef 本身——递 .current 等于节点快照，兜底静默失活。
   * syncScroll 交 releasePin：兜底直接写 scrollTop，容器上的 wheel 监听收不到，
   * 不交还位置判定的话高亮会赖在刚才点过的那一节。
   */
  const workbenchRef = useRef<HTMLDivElement | null>(null);
  useWheelColumnResolver(workbenchRef);
  useWheelSurface(panelsRef, { syncScroll: releasePin });
  const savedTimerRef = useRef<number | null>(null);
  /*
   * 数据目录一节的三条提示通道也接「出现即滚进可视区」（轮67 R67-WP7）。
   * 真机量过（先把面板滚到本节底部再点）：容器可视区底边 798，「需重启」提示块顶边 884——
   * 86px 落在框外，用户点完「更改位置…」看不到任何反馈，与备份面板 R67-WP1 同一个毛病。
   * 引用一律落在提示自己的根节点上，不另加包裹层（面板是 flex column，多一层就改间距）。
   */
  const restartNoticeRef = useKeepVisible<HTMLDivElement>(!!restartNotice, restartNotice);
  const dataRootErrorRef = useKeepVisible<HTMLDivElement>(!!dataRootError, dataRootError);
  const openFolderErrorRef = useKeepVisible<HTMLDivElement>(!!openFolderError, openFolderError);
  const revisionOkRef = useKeepVisible<HTMLDivElement>(revisionResult === "ok");
  const revisionErrorRef = useKeepVisible<HTMLDivElement>(!!revisionError, revisionError);
  const cacheErrorRef = useKeepVisible<HTMLDivElement>(!!cacheError, cacheError);
  /*
   * 代理三框的草稿（轮72 R-B2）：草稿活在这一框里，落盘只发生在失焦 / Enter 那一刻。
   * 原来每次按键都原样写进 cs.settings —— 打进 `   not-a-url   ` 就直接进盘，界面上一处
   * 都不说它不对，直到下一次检查更新才发现「代理静默失效」，那时已经没人怀疑设置页了。
   */
  const [proxyDraft, setProxyDraft] = useState<ProxySettings>(() => ({ ...settings.proxy }));
  const [proxyIssues, setProxyIssues] = useState<Partial<Record<ProxyField, { issue: ProxyIssue; detail: string }>>>({});

  const sectionLinks = SECTION_NAV.map((item) => ({ id: item.id, label: t(item.labelKey) }));

  /** 「设置已保存」就近徽章：只在被改动的那一节渲染，绝对定位不占布局。 */
  const savedFlagFor = (panelId: string) =>
    saved && savedPanel === panelId ? (
      <div className="test-msg ok settings-panel-flag" {...statusMessageProps("success")}>
        {t("settings.settingsSaved")}
      </div>
    ) : null;

  const update = (patch: SettingsPatch, savedIn?: string) => {
    /*
     * 合并基准从盘上读，不用渲染闭包里那份 settings（轮72 R-B2）：代理一框改成失焦提交后，
     * 同一次交互里可能连着两次 update（先提交代理、再动别的开关），第二次拿的闭包还是渲染前的旧值，
     * 整段合并会把第一次刚写进去的字段吃掉。写完由 saveSettings 广播，读侧（useSettings）自己跟上。
     */
    const current = loadSettings();
    saveSettings({
      ...current,
      ...patch,
      proxy: { ...current.proxy, ...(patch.proxy ?? {}) },
      compare: { ...current.compare, ...(patch.compare ?? {}) },
      update: { ...current.update, ...(patch.update ?? {}) },
      startup: { ...current.startup, ...(patch.startup ?? {}) },
    });
    setSaved(true);
    setSavedPanel(savedIn ?? null);
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

  /*
   * 已提交的值变了（About 写了 skipVersion、清理缓存后重新水合、别的页面写完广播），草稿才跟着走。
   * 「草稿仍等于盘上的值」时不动它：否则用户正在打的字会被整片覆盖成上一次提交的结果。
   */
  useEffect(() => {
    setProxyDraft((draft) => (isSameProxy(draft, settings.proxy) ? draft : { ...settings.proxy }));
  }, [settings.proxy]);

  /** 提交一框代理：非法只在本框下方说清哪里不对，不写盘；合法才落库并回显归一值。 */
  const commitProxyField = (field: ProxyField, raw: string) => {
    const outcome = readProxyField(field, raw);
    if (!outcome.valid) {
      setProxyIssues((issues) => ({ ...issues, [field]: { issue: outcome.issue, detail: outcome.detail ?? "" } }));
      return;
    }
    setProxyIssues((issues) => {
      if (!issues[field]) return issues;
      const next = { ...issues };
      delete next[field];
      return next;
    });
    // 回显归一后的值：用户看到的和盘上存的是同一串（trim、协议小写、noProxy 逐项整理）
    setProxyDraft((draft) => (draft[field] === outcome.value ? draft : { ...draft, [field]: outcome.value }));
    if (outcome.value !== settings.proxy[field]) {
      update({ proxy: { [field]: outcome.value } as Partial<ProxySettings> }, "settings-network");
    }
  };

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
    // 版本历史的体量事实：旧 Go 二进制没有这颗绑定就让它缺席（safeCall 已吞同步抛与 reject），
    // 界面据此不摆一颗点了必然报错的「清除」键。
    safeCall(GetConfigRevisionFacts, (facts) => {
      setRevisionFacts(facts);
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
    setCacheError("");
    try {
      await clearAppCache();
      setCacheResult("ok");
    } catch (e) {
      setCacheResult("fail");
      setCacheError(errorText(e));
    } finally {
      setCacheBusy(false);
    }
  };

  /*
   * 清除本机版本历史（R11：与开发者的「清理缓存」是两个入口，不许混）。
   *
   * 清完必须连前端那份 md5 记忆一起清（resetConfigRevisionAccelerator）：那些 md5 属于
   * 刚被删掉的那份文件，留着它们，同样的正文再读到会被加速器直接跳过 IPC，
   * 本机历史从此再也攒不起来——用户看到的是「清除之后这个功能就再也不记了」。
   * Go 侧的内存索引由 Clear 自己重建，不需要前端管。
   *
   * 失败要把原文拿出来（InlineError 自带复制键）：这条错误通常指向文件权限或磁盘，
   * 用户能抄走那句话才可能自己去查，不该只在屏幕上念一遍。
   */
  const runClearConfigRevisions = async () => {
    if (revisionBusy) return;
    setRevisionBusy(true);
    setRevisionResult("");
    setRevisionError("");
    try {
      await ClearConfigRevisions();
      resetConfigRevisionAccelerator();
      setRevisionResult("ok");
      // 文件与体量都变了：连数据位置清单一起刷，否则路径行还挂着「已创建」而文件已经没了。
      refreshDataSurfaces();
    } catch (e) {
      setRevisionResult("fail");
      setRevisionError(errorText(e));
    } finally {
      setRevisionBusy(false);
    }
  };

  return (
    <div className="page-surface settings-page">
      <div className="page-header">
        <div>
          <h3>{t("app.settings")}</h3>
          <div className="page-subtitle">{t("app.settingsSubtitle")}</div>
        </div>
      </div>
      <div className="settings-workbench" ref={workbenchRef}>
        {/*
         * 兜底落点（轮73 R73-I2）：调用方没点名是哪一节时（新写的开关忘了传 savedIn、
         * 或改动不属于任何一节），徽章仍出现在内容区右上角——宁可远一点，也不能没有。
         */}
        {saved && savedPanel === null && (
          <div className="test-msg ok settings-saved-flag" {...statusMessageProps("success")}>
            {t("settings.settingsSaved")}
          </div>
        )}
        <aside className="settings-rail" aria-label={t("settings.railAriaLabel")} onKeyDown={moveRailFocus}>
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

        <div ref={panelsScroll.ref} className="settings-panels" onScroll={panelsScroll.onScroll}>
          <section id="settings-general" className="settings-panel" tabIndex={-1} aria-labelledby="settings-general-title">
            {savedFlagFor("settings-general")}
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
            {savedFlagFor("settings-network")}
            <div className="settings-panel-head">
              <h4 id="settings-network-title">{t("settings.groupNetwork")}</h4>
              <div className="settings-panel-description">{t("settings.networkDescription")}</div>
            </div>
            <div className="settings-proxy-grid">
              {PROXY_FIELDS.map((field) => {
                const issue = proxyIssues[field];
                return (
                  <label key={field} className="field">
                    <span>{t(PROXY_LABEL_KEYS[field])}</span>
                    <input
                      type="text"
                      className="search-input"
                      spellCheck={false}
                      value={proxyDraft[field]}
                      placeholder={PROXY_PLACEHOLDERS[field]}
                      onChange={(e) => setProxyDraft((draft) => ({ ...draft, [field]: e.target.value }))}
                      onBlur={(e) => commitProxyField(field, e.target.value)}
                      onKeyDown={(e) => {
                        // Enter 提交；输入法组词期间的 Enter 是「选这个词」，不能当提交（与查找框同口径）
                        if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                        e.preventDefault();
                        // currentTarget 才是这一框（React 给 onKeyDown 的 target 只标到 EventTarget，取不到 value）
                        commitProxyField(field, e.currentTarget.value);
                      }}
                    />
                    {issue && (
                      <span className="field-error" role="alert">
                        {t(PROXY_ISSUE_KEYS[issue.issue], { item: issue.detail })}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
            {/* 两条早就写好却没被显示出来的说明（轮72）：proxyOnlyForUpdate 是 settings 里躺着的死键，
                用户按「网络」这一节的标题会以为代理管着 Nacos 请求，实际上它只管更新检查与下载。 */}
            <div className="field-hint">{t("settings.proxyOnlyForUpdate")}</div>
            <div className="field-hint">{t("settings.noProxyPatternHint")}</div>
          </section>

          <section id="settings-compare" className="settings-panel" tabIndex={-1} aria-labelledby="settings-compare-title">
            {savedFlagFor("settings-compare")}
            <div className="settings-panel-head">
              <h4 id="settings-compare-title">{t("settings.comparePreferences")}</h4>
              <div className="settings-panel-description">{t("settings.compareDescription")}</div>
            </div>
            {/*
              * 整行可点（轮72 R-B4）：原先只有那颗 16px 的方框能按，点标题什么都不发生。
              * label 包住「标题 + 复选框」，说明文字放在 label 外面——包进去会连整句说明
              * 一起变成这个复选框的可访问名（读屏每按一次就念一遍说明书）。
              */}
            <label className="settings-setting-row settings-setting-row-clickable">
              <span>{t("settings.sortConnections")}</span>
              <input
                type="checkbox"
                checked={settings.compare.sortConnections}
                onChange={(e) => update({ compare: { sortConnections: e.target.checked } }, "settings-compare")}
              />
            </label>
            <div className="field-hint">{t("settings.compareSortConnectionsHint")}</div>
            <label className="settings-setting-row settings-setting-row-clickable">
              <span>{t("settings.sortNamespaces")}</span>
              <input
                type="checkbox"
                checked={settings.compare.sortNamespaces}
                onChange={(e) => update({ compare: { sortNamespaces: e.target.checked } }, "settings-compare")}
              />
            </label>
            <div className="field-hint">{t("settings.compareSortNamespacesHint")}</div>
          </section>

          <section id="settings-credentials" className="settings-panel" tabIndex={-1} aria-labelledby="settings-credentials-title">
            {savedFlagFor("settings-credentials")}
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
            {savedFlagFor("settings-backup")}
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
                  {/* 路径可复制（轮72 R-B5）：这一节右边七行数据位置每行都有复制键，
                      偏偏最该抄的主数据文件路径没有——排查问题时用户要的正是这一串。 */}
                  <div className="settings-data-file-path">
                    <span>{t("settings.dataFilePath")}</span>
                    <code>{docInfo.path || t("settings.dataFileNone")}</code>
                    {!!docInfo.path && (
                      <CopyButton text={docInfo.path} ariaLabel={t("settings.copyPathAria", { name: t("settings.dataFile") })} />
                    )}
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
            {savedFlagFor("settings-data-locations")}
            <div className="settings-panel-head">
              <h4 id="settings-data-locations-title">{t("settings.dataLocations")}</h4>
              <div className="settings-panel-description">{t("settings.dataLocationsDescription")}</div>
            </div>
            {/*
              * 三条提示挂在节首、紧挨着「更改位置…」上方（轮67 R67-WP7）。
              * 挂在节尾时真机量到两个毛病：① 提示顶边落在可视区外 86px；② 接上「出现即滚进可视区」
              * 之后仍然差 23px——迁移成功后 refreshDataSurfaces() 才落地，它上方那 7 行路径长高，
              * 把刚滚进框的提示又顶了出去（关闭键正好被裁掉）。
              * 挂到节首让「提示之上只有静态标题」，迟到的内容一律在它下方生长，落点就稳了；
              * 与 AppDataBackupPanel 的提示位也同口径。
              */}
            {restartNotice && (
              /*
               * 关闭键挂在 div 上、不挂进 label（轮67 R67-WP9 量过 label 的代价：整行 accname
               * 会把按钮的 × 也算进去）。tone 与播报语义一个字不动，只多一条「我看完了」的出口——
               * 这条提示原先没有任何关闭手段，重启前它一直占着界面。
               */
              <div ref={restartNoticeRef} className="test-msg warn" {...statusMessageProps("info")}>
                <span className="test-msg-text">{restartNotice}</span>
                <button type="button" className="test-msg-close" title={closeLabel} aria-label={closeLabel} onClick={() => setRestartNotice("")}>
                  ×
                </button>
              </div>
            )}
            {dataRootError && (
              <div ref={dataRootErrorRef} className="inline-error" role="alert">
                {t("settings.dataRootActionFailed", { error: dataRootError })}
              </div>
            )}
            {openFolderError && (
              <div ref={openFolderErrorRef} className="inline-error" role="alert">
                {t("settings.openFolderFailed", { error: openFolderError })}
              </div>
            )}
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
                {dataLocations.entries.map((entry) => {
                  const rowName = t(`settings.dataLoc${entry.key.charAt(0).toUpperCase()}${entry.key.slice(1)}`);
                  return (
                    <div key={entry.key} className="settings-setting-row">
                      <div>
                        <strong>
                          {rowName}
                          {!entry.exists && <span className="settings-data-location-missing">{t("settings.dataLocMissing")}</span>}
                        </strong>
                        <div className="settings-data-location-path" title={entry.path}>
                          <code>{entry.path}</code>
                        </div>
                      </div>
                      {/*
                        轮67 R67-WP5：7 行 14 颗按钮原先的可访问名全是「复制」「打开」各刷 7 遍
                        （真机 aria-label 全 null），键盘走到第 34 颗时听不出这是日志目录还是备份快照。
                        可见文字一个字不动，只给读屏点名是哪一行；按 WCAG 2.5.3 把可见文字含在名字里。
                      */}
                      <div className="settings-data-location-actions">
                        <CopyButton text={entry.path} ariaLabel={t("settings.copyPathAria", { name: rowName })} />
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          aria-label={t("settings.openFolderAria", { name: rowName })}
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
                  );
                })}
              </div>
            ) : (
              <div className="settings-panel-note">{t("settings.dataLocationsUnavailable")}</div>
            )}
            {/*
              * 本机版本历史的体量与清除入口（R57-WP14）。行标题用动作名而不是数据名：
              * 上面清单里已经有一行叫「本机版本历史」（那是文件位置），再来同名的一行
              * 就成了两行一个名字，用户分不清哪行才是能按的。形状照「清理缓存」那行抄：
              * 标题 = 动作、说明 = 后果、右侧 = 一颗同名的键。
              */}
            {revisionFacts && (
              <div className="settings-setting-row settings-danger-zone">
                <div>
                  <strong>{t("settings.clearRevisions")}</strong>
                  <div className="settings-panel-description">{t("settings.revisionHistoryHint")}</div>
                  <div className="settings-data-root-facts">
                    <span>{t("settings.revisionFactsRecords", { count: revisionFacts.records })}</span>
                    <span>{t("settings.revisionFactsKeys", { count: revisionFacts.keys })}</span>
                    <span>{t("settings.revisionFactsSize", { size: formatBytes(revisionFacts.sizeBytes) })}</span>
                    <span>{t("settings.revisionFactsKeep", { count: revisionFacts.keepPerKey })}</span>
                  </div>
                </div>
                <div className="settings-data-location-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-danger settings-busy-btn"
                    disabled={revisionBusy}
                    onClick={() =>
                      askConfirm(t("settings.clearRevisions"), t("settings.confirmClearRevisions"), () => void runClearConfigRevisions(), [
                        t("settings.revisionFactsRecords", { count: revisionFacts.records }),
                        t("settings.revisionFactsSize", { size: formatBytes(revisionFacts.sizeBytes) }),
                        t("settings.revisionFactsServerUntouched"),
                      ])
                    }
                  >
                    {revisionBusy ? t("settings.clearingRevisions") : t("settings.clearRevisions")}
                  </button>
                </div>
              </div>
            )}
            {/* 原生侧在但读不到体量（旧 Go 二进制没有这颗绑定）才补一句说明：
                纯浏览器构建里连数据位置都不可用，上面已经说过一次，不该在这儿再念一遍。 */}
            {dataLocations && !revisionFacts && <div className="settings-panel-note">{t("settings.revisionFactsUnavailable")}</div>}
            {revisionResult === "ok" && (
              <div ref={revisionOkRef} className="test-msg ok" {...statusMessageProps("success")}>
                {t("settings.clearRevisionsSuccess")}
              </div>
            )}
            {revisionError && <InlineError title={t("settings.clearRevisionsFailed")} message={revisionError} containerRef={revisionErrorRef} />}
          </section>
          <section id="settings-update" className="settings-panel" tabIndex={-1} aria-labelledby="settings-update-title">
            {savedFlagFor("settings-update")}
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
                  onClick={() => {
                    update({ update: { skipVersion: "" } }, "settings-update");
                    // 清空是「点了一下、但屏幕上什么都没挪」的动作（右上角那条徽章 1.2s 就没了），
                    // 补一条轻提示说明接下来会发生什么：下次检查会重新提示这个版本。
                    toast(t("settings.updateReminderRestored"), "success");
                  }}
                >
                  {t("settings.restoreUpdateReminder")}
                </button>
              </div>
            </div>
            {/* 检查更新的整套动作（检查 / 下载 / 校验 / 安装 / 交接）只在关于页有一份实现，
                这里不复制第二个按钮逻辑，只负责把人送过去（轮72 R-B6）。 */}
            <div className="settings-setting-row">
              <div>
                <strong>{t("settings.checkUpdatesInAbout")}</strong>
                <div className="settings-panel-description">{t("settings.checkUpdatesInAboutHint")}</div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenAbout}>
                {t("about.checkUpdate")}
              </button>
            </div>
          </section>

          <section id="settings-developer" className="settings-panel" tabIndex={-1} aria-labelledby="settings-developer-title">
            {savedFlagFor("settings-developer")}
            <div className="settings-panel-head">
              <h4 id="settings-developer-title">{t("settings.developer")}</h4>
              <div className="settings-panel-description">{t("settings.developerDescription")}</div>
            </div>
            <div className="settings-setting-row settings-danger-zone">
              <div>
                <strong>{t("settings.clearCache")}</strong>
                <div className="settings-panel-description">{t("settings.clearCacheHint")}</div>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-danger settings-busy-btn"
                disabled={cacheBusy}
                onClick={() => askConfirm(t("settings.clearCache"), t("settings.confirmClearCache"), () => void runClearCache())}
              >
                {cacheBusy ? t("settings.clearingCache") : t("settings.clearCache")}
              </button>
            </div>
            {cacheResult === "ok" && (
              <div className="test-msg ok" {...statusMessageProps("success")}>
                {t("settings.clearCacheSuccess")}
              </div>
            )}
            {cacheResult === "fail" && cacheError && (
              <InlineError title={t("settings.clearCacheFailed")} message={cacheError} containerRef={cacheErrorRef} />
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
