import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { clickableRowProps } from "../lib/clickableRow";
import {
  Connection,
  DEFAULT_ENVIRONMENT_NAME,
  DEFAULT_PROJECT_NAME,
  SSHConfig,
  connectionEnvironmentName,
  connectionProjectName,
  connectionSourceName,
  deleteConnection,
  loadConnections,
  renameProject,
  upsertConnection,
} from "../store/connections";
import { loadSSHProfiles, normalizeSSHConfig, sshProfileLabel, upsertSSHProfile, type SSHProfile } from "../store/sshProfiles";
import {
  CONNECTION_SECRET_FIELDS,
  CONNECTION_SECRET_LABEL_KEYS,
  SSH_SECRET_FIELDS,
  SSH_SECRET_LABEL_KEYS,
  connectionSecretPatch,
  loadConnectionSecretsForEdit,
  loadSSHSecretsForEdit,
  settleConnectionSecrets,
  settleSSHSecrets,
  sshSecretPatch,
  type ConnectionSecretField,
  type SecretEditNotice,
  type SSHSecretField,
} from "../lib/credentialSecrets";
import { clearToken, listNamespaces, testConnection, type Namespace } from "../api/nacos";
import { selectLocalSnapshotDirectory, validateLocalSnapshotDirectory, type LocalSnapshotValidation } from "../api/app";
import { useTranslation } from "../i18n";
import { localizeDefaultName, sourceLabel } from "../lib/defaultNameCopy";
import CopyButton from "./CopyButton";
import NumberField from "./NumberField";
import { PORT_MAX, PORT_MIN, SSH_DEFAULT_PORT, portIssue, sshPortIssues } from "../lib/ports";
import { environmentTone } from "../lib/envTone";
import TestTraceView, { TestTrace, TraceStep } from "./TestTraceView";
import PasswordField from "./PasswordField";
import { EscapePriority, isImeComposing, useEscape } from "../lib/useEscape";
import { useDialogFocus } from "../lib/useDialogFocus";
import { useOverlayDismiss } from "../lib/useOverlayDismiss";
import { errorText } from "../lib/errorText";
import { statusMessageProps } from "../lib/statusSemantics";

interface Props {
  onClose: () => void;
  onChange: (conns: Connection[]) => void;
  embedded?: boolean;
}

type Draft = Omit<Connection, "id"> & {
  id?: string;
  /**
   * 打开表单那一刻读回来的小凭据值＝保存时判定「用户动没动」的基线（轮142 C）。
   * 只活在内存：Draft 整份 spread 进 upsertConnection，落盘前由 normalizeConnection 的白名单丢掉。
   */
  secretBaseline?: Record<string, string>;
  /** 内联 SSH 大凭据的同一份基线（namespace connection-ssh）。 */
  sshSecretBaseline?: Record<string, string>;
};

/**
 * 是否为「单行文本类输入框」——只有它值得把 Enter 当成提交表单。
 * 排除 checkbox / radio / file / button / submit 这些自带激活语义的类型；
 * textarea 天然不等于 input，因此私钥多行粘贴不受影响。
 */
function isSingleLineTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLInputElement)) return false;
  if (target.disabled || target.readOnly) return false;
  const type = (target.type || "text").toLowerCase();
  return !["checkbox", "radio", "file", "button", "submit", "reset"].includes(type);
}

const emptyDraft = (environmentName = DEFAULT_ENVIRONMENT_NAME): Draft => ({
  name: "",
  projectName: DEFAULT_PROJECT_NAME,
  environmentName,
  sourceName: "",
  sourceType: "nacos",
  readonly: false,
  isDefaultSource: false,
  tags: [],
  provider: "nacos",
  distribution: "opensource",
  authType: "nacos-password",
  baseUrl: "http://localhost:8848/nacos",
  username: "nacos",
  password: "",
  defaultNamespace: "",
  defaultGroup: "",
  sshConfig: undefined,
  sshProfileId: "",
  useProxy: false,
  apolloEnv: "DEV",
  apolloAppId: "",
  apolloCluster: "default",
  apolloNamespaceName: "application",
  apolloToken: "",
  consulToken: "",
  consulDatacenter: "dc1",
  consulKeyPrefix: "",
});

type HelpPopover = { text: string; top: number; left: number };
type Translate = (key: string, params?: Record<string, string | number>) => string;

function providerDefaultNamespace(draft: Pick<Draft, "provider" | "defaultNamespace" | "apolloAppId" | "consulDatacenter">): string {
  if (draft.provider === "apollo") return draft.apolloAppId?.trim() || "";
  if (draft.provider === "consul") return draft.consulDatacenter?.trim() || "";
  return draft.defaultNamespace ?? "";
}

function latencyText(t: Translate, startedAt: number): string {
  return t("connection.testLatency", { time: Math.max(0, Date.now() - startedAt) });
}

function TestButton({ onClick, running }: { onClick: () => void; running: boolean }) {
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (running) {
      setElapsed(0);
      intervalRef.current = setInterval(() => setElapsed((v) => v + 1), 1000);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [running]);

  const slow = elapsed > 3;
  const label = running
    ? slow
      ? `${t("connection.retrying")} (${elapsed}s)...`
      : `${t("connection.testing")} (${elapsed}s)...`
    : t("connection.test");

  return (
    <button className={`btn btn-ghost${slow ? " warn" : ""}`} onClick={onClick} disabled={running}>
      {label}
    </button>
  );
}

function displayTestMessage(text: string): string {
  const value = text.trim();
  if (value.length <= 360) return value;
  return `${value.slice(0, 360)}...`;
}

function localSnapshotValidationMessage(
  result: Pick<LocalSnapshotValidation, "valid" | "code" | "message" | "configCount">,
  t: Translate
): string {
  const keyByCode: Record<string, string> = {
    empty_path: "connection.localValidationEmptyPath",
    not_found: "connection.localValidationNotFound",
    not_directory: "connection.localValidationNotDirectory",
    missing_structure: "connection.localValidationMissingStructure",
    missing_configs: "connection.localValidationMissingConfigs",
    invalid_metadata: "connection.localValidationInvalidMetadata",
    unsupported_schema_version: "connection.localValidationUnsupportedSchema",
    missing_schema_fields: "connection.localValidationMissingSchemaFields",
    legacy_valid: "connection.localValidationLegacyOk",
  };
  const key = result.code ? keyByCode[result.code] : undefined;
  if (key) return t(key);
  if (result.valid) return t("connection.localValidationOk").replace("{count}", String(result.configCount));
  return result.message;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function traceSshConfig(snapshot: Draft): SSHConfig | undefined {
  return snapshot.sshProfileId ? undefined : normalizeSSHConfig(snapshot.sshConfig);
}

function traceHasSSH(snapshot: Draft): boolean {
  const sshConfig = traceSshConfig(snapshot);
  return !!snapshot.sshProfileId || !!sshConfig?.host;
}

function traceProviderName(snapshot: Draft, t: Translate): string {
  if (snapshot.provider === "apollo") return "Apollo";
  if (snapshot.provider === "consul") return "Consul";
  return snapshot.distribution === "aliyun-mse" ? t("connection.aliyunMseNacos") : "Nacos";
}

function sshTraceDetail(snapshot: Draft, t: Translate): string {
  const sshConfig = traceSshConfig(snapshot);
  if (snapshot.sshProfileId) return t("connection.traceSshProfileSelected");
  if (!sshConfig?.host) return t("connection.traceSshNotConfigured");
  return `${sshConfig.host}:${sshConfig.port} / ${sshConfig.username}`;
}

function looksLikeTunnelForwardError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    (text.includes("localhost") || text.includes("127.0.0.1")) &&
    (text.includes("wsarecv") ||
      text.includes("forcibly closed") ||
      text.includes("connection reset") ||
      text.includes("connection refused") ||
      text.includes("broken pipe") ||
      text.includes("eof"))
  );
}

function looksLikeConfigCenterResponse(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("nacos 返回") ||
    text.includes("apollo 返回") ||
    text.includes("consul 返回") ||
    text.includes("http status") ||
    text.includes('"status":') ||
    text.includes("check signature") ||
    text.includes("invalid access key") ||
    text.includes("invalid signature") ||
    text.includes("forbidden") ||
    text.includes("unauthorized")
  );
}

function buildConnectionTrace(snapshot: Draft, startedAt: number, ok: boolean, detail: string, t: Translate): TestTrace {
  const hasSSH = traceHasSSH(snapshot);
  const tunnelForwardError = hasSSH && !ok && looksLikeTunnelForwardError(detail);
  const configCenterResponse = ok || looksLikeConfigCenterResponse(detail);
  const sshSetupError = hasSSH && !ok && !tunnelForwardError && !configCenterResponse;
  const interfaceName =
    snapshot.provider === "apollo"
      ? "Apollo OpenAPI"
      : snapshot.provider === "consul"
        ? "Consul HTTP API"
      : snapshot.distribution === "aliyun-mse"
        ? t("connection.traceMseNacosApi")
        : t("connection.traceNacosApi");
  const steps: TraceStep[] = [
    {
      name: t("connection.traceConnectionParams"),
      status: "checked",
      detail: t("connection.traceConnectionParamsDetail", {
        provider: traceProviderName(snapshot, t),
        baseUrl: snapshot.baseUrl,
      }),
    },
  ];
  if (hasSSH) {
    steps.push({
      name: t("connection.traceSshConfig"),
      status: "ok",
      detail: sshTraceDetail(snapshot, t),
    });
    steps.push({
      name: t("connection.traceLocalTunnel"),
      status: sshSetupError ? "error" : "ok",
      detail: tunnelForwardError
        ? t("connection.traceLocalTunnelForwardFailed")
        : configCenterResponse
          ? t("connection.traceLocalTunnelForwarded")
          : t("connection.traceLocalTunnelUnknown"),
    });
    steps.push({
      name: t("connection.traceRemoteTarget"),
      status: tunnelForwardError ? "error" : sshSetupError ? "skipped" : "ok",
      detail: tunnelForwardError
        ? t("connection.traceRemoteTargetForwardFailed", { error: detail })
        : sshSetupError
          ? t("connection.traceRemoteTargetSkipped")
          : ok
            ? t("connection.traceRemoteTargetConnected")
            : t("connection.traceRemoteTargetConfirmed"),
    });
  }
  steps.push({
    name: interfaceName,
    status: tunnelForwardError || sshSetupError ? "skipped" : ok ? "ok" : "error",
    detail: tunnelForwardError
      ? t("connection.traceApiSkippedRemoteFailed")
      : sshSetupError
        ? t("connection.traceApiSkippedSshFailed")
        : detail,
    latencyMs: elapsedMs(startedAt),
  });
  return {
    ok,
    title: ok ? t("connection.traceSuccessTitle") : t("connection.traceFailureTitle"),
    summary: ok
      ? hasSSH
        ? t("connection.traceSuccessSshSummary")
        : t("connection.traceSuccessDirectSummary")
      : tunnelForwardError
        ? t("connection.traceFailureTunnelSummary")
        : sshSetupError
          ? t("connection.traceFailureSshSummary")
          : hasSSH
            ? t("connection.traceFailureSshApiSummary")
            : t("connection.traceFailureDirectSummary"),
    steps,
  };
}

function connectionTestKey(draft: Draft): string {
  const sshConfig = normalizeSSHConfig(draft.sshConfig);
  return JSON.stringify({
    id: draft.id ?? "",
    sourceType: draft.sourceType ?? "nacos",
    baseUrl: draft.baseUrl ?? "",
    localPath: draft.localPath ?? "",
    distribution: draft.distribution ?? "opensource",
    authType: draft.authType ?? "none",
    username: draft.username ?? "",
    accessKeyId: draft.accessKeyId ?? "",
    securityToken: draft.securityToken ?? "",
    defaultNamespace: providerDefaultNamespace(draft),
    defaultGroup: draft.provider === "nacos" ? (draft.defaultGroup ?? "") : "",
    sshProfileId: draft.sshProfileId ?? "",
    sshConfig: sshConfig.host ? sshConfig : undefined,
    forceLocalSnapshot: !!draft.forceLocalSnapshot,
    apolloEnv: draft.apolloEnv ?? "",
    apolloAppId: draft.apolloAppId ?? "",
    apolloCluster: draft.apolloCluster ?? "",
    apolloNamespaceName: draft.apolloNamespaceName ?? "",
    apolloToken: draft.apolloToken ?? "",
    consulToken: draft.consulToken ?? "",
    consulDatacenter: draft.consulDatacenter ?? "",
    consulKeyPrefix: draft.consulKeyPrefix ?? "",
  });
}

function namespaceLoadKey(draft: Draft): string {
  const sshConfig = normalizeSSHConfig(draft.sshConfig);
  return JSON.stringify({
    id: draft.id ?? "",
    sourceType: draft.sourceType ?? "nacos",
    baseUrl: draft.baseUrl ?? "",
    distribution: draft.distribution ?? "opensource",
    authType: draft.authType ?? "none",
    username: draft.username ?? "",
    accessKeyId: draft.accessKeyId ?? "",
    securityToken: draft.securityToken ?? "",
    sshProfileId: draft.sshProfileId ?? "",
    sshConfig: sshConfig.host ? sshConfig : undefined,
    apolloEnv: draft.apolloEnv ?? "",
    apolloAppId: draft.apolloAppId ?? "",
    apolloCluster: draft.apolloCluster ?? "",
    apolloNamespaceName: draft.apolloNamespaceName ?? "",
    apolloToken: draft.apolloToken ?? "",
    consulToken: draft.consulToken ?? "",
    consulDatacenter: draft.consulDatacenter ?? "",
    consulKeyPrefix: draft.consulKeyPrefix ?? "",
  });
}

function sourceAddress(conn: Pick<Connection, "sourceType" | "localPath" | "baseUrl">): string {
  return conn.sourceType === "local-snapshot" ? conn.localPath || conn.baseUrl : conn.baseUrl;
}

function connectionLabelMeta(conn: Pick<Connection, "name" | "sourceName">): string {
  const sourceName = conn.sourceName?.trim();
  const label = conn.name?.trim();
  return label && label !== sourceName ? label : "";
}

function copyLabel(value: string | undefined, fallback: string, suffix: string): string {
  const base = value?.trim() || fallback;
  return base.includes(suffix) ? base : `${base}${suffix}`;
}

function getHelpPopover(text: string, target: HTMLElement): HelpPopover {
  const rect = target.getBoundingClientRect();
  const width = Math.min(320, Math.max(220, window.innerWidth - 24));
  const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, 12), window.innerWidth - width - 12);
  const estimatedHeight = 92;
  const top =
    rect.top > estimatedHeight + 18 ? rect.top - estimatedHeight - 8 : Math.min(rect.bottom + 8, window.innerHeight - estimatedHeight - 12);
  return { text, top, left };
}

function HelpTip({ text, onShow, onHide }: { text: string; onShow: (popover: HelpPopover) => void; onHide: () => void }) {
  const show = (target: EventTarget & HTMLElement) => onShow(getHelpPopover(text, target));
  return (
    <span
      className="help-tip"
      title={text}
      aria-hidden="true"
      onMouseEnter={(e) => show(e.currentTarget)}
      onFocus={(e) => show(e.currentTarget)}
      onMouseLeave={onHide}
      onBlur={onHide}
    >
      ?
    </span>
  );
}

function FieldLabel({
  children,
  tip,
  required = false,
  id,
  onHelpShow,
  onHelpHide,
}: {
  children: ReactNode;
  tip?: string;
  required?: boolean;
  /**
   * 标题元素的 id（轮67 R67-WP9）：给那些「同一只 <label> 里还坐着动作按钮」的框用。
   * label 内其它交互元素的文字会被浏览器的 accname 算法并进输入框的名字，
   * 唯一干净的来源是显式 `aria-labelledby` 指向这只只有标题文字的元素。
   */
  id?: string;
  onHelpShow: (popover: HelpPopover) => void;
  onHelpHide: () => void;
}) {
  return (
    <span className="field-label" id={id}>
      <span>{children}</span>
      {required && (
        <span className="required-mark" aria-hidden="true">
          *
        </span>
      )}
      {tip && <HelpTip text={tip} onShow={onHelpShow} onHide={onHelpHide} />}
    </span>
  );
}

const sshLockIconPaths = ["M8 10V7.5a4 4 0 0 1 8 0V10", "M5.5 10h13v9h-13z", "M12 13.5v2"];

/**
 * SSH 徽标前的线性锁（轮79 E3）。
 *
 * 以前这里挂的是彩色 emoji 🔒：它与全站线性图标不同族，会进徽标的可访问名（读屏念「锁 号 SSH」），
 * 且 Windows/macOS 两套字形宽窄不同。图标语言只留一套：`fill:none` + `stroke:currentColor`，与
 * `PasswordField` 的眼睛、`ConfigBrowser` 的工具图标同一档。
 */
function SshLockIcon() {
  return (
    <svg className="conn-ssh-badge-icon" viewBox="0 0 24 24" aria-hidden="true">
      {sshLockIconPaths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export default function ConnectionManager({ onClose, onChange, embedded = false }: Props) {
  const { t } = useTranslation();
  const defaultNewEnvironment = t("connection.environmentDev");
  // 轮47 R47-02：惰性初值。原来 useState(loadConnections()) 每次渲染都解析一遍磁盘再丢弃
  // （实测每轮 5.8 µs，60 条连接时 69.8 µs）——React 只消费首帧返回值，其余全是白读。
  // 这份列表的重取入口是 refresh()（写侧显式调用），不依赖渲染期读盘。
  const [list, setList] = useState<Connection[]>(() => loadConnections());
  const [sshProfiles, setSSHProfiles] = useState<SSHProfile[]>(() => loadSSHProfiles());
  const [draft, setDraft] = useState<Draft>(emptyDraft(defaultNewEnvironment));
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testTrace, setTestTrace] = useState<TestTrace | null>(null);
  const [testResultKey, setTestResultKey] = useState<string | null>(null);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [helpPopover, setHelpPopover] = useState<HelpPopover | null>(null);
  const [localValidation, setLocalValidation] = useState<LocalSnapshotValidation | null>(null);
  const [validatingLocal, setValidatingLocal] = useState(false);
  const [selectingLocalDir, setSelectingLocalDir] = useState(false);
  const [namespaceLoadingKey, setNamespaceLoadingKey] = useState<string | null>(null);
  const [namespaceResultKey, setNamespaceResultKey] = useState<string | null>(null);
  const [namespaceOptions, setNamespaceOptions] = useState<Namespace[]>([]);
  const [namespaceError, setNamespaceError] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState(emptyDraft(defaultNewEnvironment).projectName ?? DEFAULT_PROJECT_NAME);
  const [activeEnvironment, setActiveEnvironment] = useState(emptyDraft(defaultNewEnvironment).environmentName ?? defaultNewEnvironment);
  const [creatingProject, setCreatingProject] = useState(false);
  const [renamingProject, setRenamingProject] = useState<{ oldName: string; value: string } | null>(null);
  // 待确认删除的连接 id（点一次 × 进入确认态，再点才删）
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [showSSHConfig, setShowSSHConfig] = useState(false);
  // 读库是异步的：用户在读回来之前切到别的连接/新建表单时，这一份过期结果必须丢掉（轮142 C）。
  const openSeqRef = useRef(0);
  const currentTestKey = connectionTestKey(draft);
  const currentNamespaceKey = namespaceLoadKey(draft);
  const currentTestKeyRef = useRef(currentTestKey);
  const currentNamespaceKeyRef = useRef(currentNamespaceKey);
  const testingCurrent = testingKey === currentTestKey;
  const loadingNamespaces = namespaceLoadingKey === currentNamespaceKey;
  const visibleNamespaces = namespaceResultKey === currentNamespaceKey ? namespaceOptions : [];
  const visibleNamespaceError = namespaceResultKey === currentNamespaceKey ? namespaceError : null;
  const visibleTestTrace = testResultKey === currentTestKey ? testTrace : null;
  const visibleTestMsg = testResultKey === null || testResultKey === currentTestKey ? testMsg : null;

  useEffect(() => {
    currentTestKeyRef.current = currentTestKey;
  }, [currentTestKey]);

  useEffect(() => {
    currentNamespaceKeyRef.current = currentNamespaceKey;
  }, [currentNamespaceKey]);

  // Esc 关闭弹框改用分层注册表：表单内的自绘下拉/候选弹层（dropdown 优先级）展开时先吃掉 Esc，
  // 不会再出现「一次 Esc 同时收起下拉并关掉整个连接弹框」；内嵌在设置页时不参与。
  useEscape(!embedded, onClose, EscapePriority.overlay);

  // 行内重命名是面板内部的瞬时编辑层，必须自己登记（R61）：焦点在这个输入框里按 Esc，
  // 只想退出重命名，不该连整个连接管理面板一起关掉。门控与上面那条对齐——
  // 面板内嵌在设置页时不参与，否则会替设置页其余表单吃掉 Esc。
  useEscape(!embedded && !!renamingProject, () => setRenamingProject(null), EscapePriority.find);

  // 焦点陷阱：内嵌在设置页里时不参与，否则会替设置页其余表单吃掉 Tab。
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // 轮67 R67-WP9：本地快照目录与默认命名空间这两只框，动作按钮就坐在同一只 <label> 里
  // （选目录/校验/加载命名空间/重试/复制）。名字来源改成显式指向标题元素，
  // 读屏念出来的才是「默认命名空间 ID（留空=public）」而不是「…加载命名空间」。
  // 「项目」这一栏更特殊：同一只 <label> 里并排坐着下拉框和新建时的文本框（按条件只显其一），
  // HTML 的隐式关联只认子树里第一只 labelable 后代——文本框因此在读屏里彻底没名字。
  // 两只都显式指向标题元素，切到「新建项目」时也念得出「项目」。
  const projectCaptionId = useId();
  const localPathCaptionId = useId();
  const namespaceCaptionId = useId();
  useDialogFocus({ active: !embedded, containerRef: modalRef });
  const overlayDismiss = useOverlayDismiss(onClose);

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    if ("localPath" in patch || "sourceType" in patch) setLocalValidation(null);
  };

  const setDistribution = (distribution: Draft["distribution"]) => {
    setDraft((d) => ({
      ...d,
      distribution,
      authType: distribution === "aliyun-mse" ? "aliyun-aksk" : "nacos-password",
      username: distribution === "aliyun-mse" ? "" : d.username || "nacos",
      password: distribution === "aliyun-mse" ? "" : d.password,
    }));
  };

  const setSSH = (patch: Partial<SSHConfig>) => {
    setDraft((d) => ({
      ...d,
      sshProfileId: "",
      sshConfig: {
        host: "",
        port: SSH_DEFAULT_PORT,
        username: "root",
        authType: "password" as const,
        ...d.sshConfig,
        ...patch,
      },
    }));
  };

  const selectedSSHProfile = sshProfiles.find((profile) => profile.id === draft.sshProfileId);

  const setSSHProfile = (profileId: string) => {
    if (!profileId) {
      setDraft((d) => ({
        ...d,
        sshProfileId: "",
        sshConfig: d.sshConfig ?? {
          host: "",
          port: SSH_DEFAULT_PORT,
          username: "root",
          authType: "password",
        },
      }));
      setShowSSHConfig(true);
      return;
    }
    setDraft((d) => ({ ...d, sshProfileId: profileId, sshConfig: undefined }));
    setShowSSHConfig(true);
  };

  const copySSHProfileToInline = async () => {
    if (!selectedSSHProfile) return;
    // 档案的凭据多半已在系统库里（config 里是空的）：不先读回来就复制，
    // 内联草稿会带着一份缺口令的配置（轮142 C）。
    const snapshot = await loadSSHSecretsForEdit(selectedSSHProfile.config, selectedSSHProfile.sshSecretRefs);
    setDraft((d) => ({
      ...d,
      sshProfileId: "",
      sshConfig: { ...selectedSSHProfile.config, ...sshSecretPatch(snapshot.values) },
      /*
       * 连接自己原来那份大凭据指针一并摘掉：此刻语义是「改用这份档案的值内联」，
       * 留着旧指针会在保存时把刚复制进来的值判成「没动」→ 内联清空 → 值哪儿都不在。
       * 库里那条旧条目就此没人引用，同一个 (namespace, ownerId, field) 下次入库会直接覆盖。
       */
      sshSecretRefs: undefined,
      sshSecretBaseline: snapshot.baseline,
    }));
    setShowSSHConfig(true);
    const message = secretHydrationMessage([
      {
        fields: SSH_SECRET_FIELDS,
        values: snapshot.values,
        unavailable: snapshot.unavailable,
        labelOf: sshSecretLabel,
        inlineValueOf: (field) => selectedSSHProfile.config[field as SSHSecretField] ?? "",
      },
    ]);
    if (message) setTestMsg(message);
  };

  const saveInlineSSHAsProfile = () => {
    // 先按原值查端口，再 normalizeSSHConfig：normalize 里 `port || 22` 会把 0 悄悄夹成合法默认值，
    // 检查顺序反了就等于把刚立的规则又吞回去（R24）
    const blockedPort = sshPortIssues(draft.sshConfig, { port: t("connection.sshPort"), localPort: t("connection.localPortShort") })[0];
    if (blockedPort) {
      setTestMsg({ ok: false, text: blockedPort });
      return;
    }
    const config = normalizeSSHConfig(draft.sshConfig);
    if (!config.host.trim() || !config.username.trim()) {
      setTestMsg({ ok: false, text: t("connection.sshProfileRequired") });
      return;
    }
    const profile = upsertSSHProfile({
      name: draft.name?.trim() || draft.sourceName?.trim() || `${config.username}@${config.host}`,
      config,
    });
    setSSHProfiles(loadSSHProfiles());
    setDraft((d) => ({ ...d, sshProfileId: profile.id, sshConfig: undefined }));
    setShowSSHConfig(true);
    setTestMsg({ ok: true, text: t("connection.sshProfileSaved") });
  };

  const setAccessMode = (mode: "direct" | "ssh") => {
    if (mode === "direct") {
      setDraft((d) => ({ ...d, sourceType: "nacos", sshConfig: undefined, sshProfileId: "" }));
      setShowSSHConfig(false);
      return;
    }

    setDraft((d) => ({
      ...d,
      sourceType: "nacos",
      sshConfig: d.sshProfileId
        ? undefined
        : (d.sshConfig ?? {
            host: "",
            port: SSH_DEFAULT_PORT,
            username: "root",
            authType: "password",
          }),
    }));
    setShowSSHConfig(true);
  };

  const groupedConnections = list.reduce<{ project: string; environments: { environment: string; connections: Connection[] }[] }[]>(
    (projects, conn) => {
      const project = connectionProjectName(conn);
      const environment = connectionEnvironmentName(conn);
      let projectGroup = projects.find((item) => item.project === project);
      if (!projectGroup) {
        projectGroup = { project, environments: [] };
        projects.push(projectGroup);
      }
      let envGroup = projectGroup.environments.find((item) => item.environment === environment);
      if (!envGroup) {
        envGroup = { environment, connections: [] };
        projectGroup.environments.push(envGroup);
      }
      envGroup.connections.push(conn);
      return projects;
    },
    []
  );
  const projectOptions = groupedConnections.map((project) => project.project);
  const environmentPresets = [
    t("connection.environmentDev"),
    t("connection.environmentTest"),
    t("connection.environmentStaging"),
    t("connection.environmentProd"),
    t("connection.environmentCanary"),
    t("connection.environmentLocal"),
  ];
  const currentEnvironment = draft.environmentName?.trim();
  const environmentOptions = Array.from(
    new Set(
      currentEnvironment && !environmentPresets.includes(currentEnvironment)
        ? [currentEnvironment, ...environmentPresets]
        : environmentPresets
    )
  );
  const accessMode = showSSHConfig || draft.sshConfig || draft.sshProfileId ? "ssh" : "direct";
  const nacosSourceNamePresets = [
    { label: t("connection.sourcePresetPublic"), mode: "direct" as const },
    { label: t("connection.sourcePresetCloudIntranet"), mode: "direct" as const },
    { label: t("connection.sourcePresetCompanyIntranet"), mode: "direct" as const },
    { label: t("connection.sourcePresetOffice"), mode: "direct" as const },
  ];
  const localSnapshotSourceNamePreset = { label: t("connection.sourcePresetLocalSnapshot"), mode: "direct" as const };
  const sourceNamePresets = draft.provider === "local" ? [localSnapshotSourceNamePreset] : nacosSourceNamePresets;
  const selectedSourcePreset = sourceNamePresets.some((item) => item.label === draft.sourceName) ? (draft.sourceName ?? "") : "";
  const currentProjectName = (draft.projectName ?? DEFAULT_PROJECT_NAME).trim();
  const selectedProjectOption = !creatingProject && projectOptions.includes(currentProjectName) ? currentProjectName : "__new__";
  const showProjectInput = creatingProject || projectOptions.length === 0 || selectedProjectOption === "__new__";

  function deriveSourceType(provider: Draft["provider"]): Draft["sourceType"] {
    if (provider === "local") return "local-snapshot";
    return "nacos";
  }

  const setProvider = (provider: Draft["provider"]) => {
    const sourceType = deriveSourceType(provider);
    setDraft((d) => {
      const wasUsingNacosPreset = nacosSourceNamePresets.some((item) => item.label === d.sourceName);
      const wasUsingLocalSnapshotPreset = d.sourceName === localSnapshotSourceNamePreset.label;
      const shouldDefaultLocalName = sourceType === "local-snapshot" && (!d.sourceName?.trim() || wasUsingNacosPreset);
      const shouldClearLocalName = sourceType !== "local-snapshot" && wasUsingLocalSnapshotPreset;

      return {
        ...d,
        provider,
        sourceType,
        distribution: provider === "apollo" || provider === "consul" ? "opensource" : d.distribution,
        authType: provider === "apollo" || provider === "consul" ? "none" : d.authType,
        username: provider === "apollo" || provider === "consul" ? "" : d.username,
        password: provider === "apollo" || provider === "consul" ? "" : d.password,
        apolloEnv: provider === "apollo" ? d.apolloEnv || "DEV" : d.apolloEnv,
        apolloCluster: provider === "apollo" ? d.apolloCluster || "default" : d.apolloCluster,
        apolloNamespaceName: provider === "apollo" ? d.apolloNamespaceName || "application" : d.apolloNamespaceName,
        consulDatacenter: provider === "consul" ? d.consulDatacenter || "dc1" : d.consulDatacenter,
        sourceName: shouldDefaultLocalName ? localSnapshotSourceNamePreset.label : shouldClearLocalName ? "" : d.sourceName,
      };
    });
    setLocalValidation(null);
  };

  const refresh = () => {
    const next = loadConnections();
    setList(next);
    onChange(next);
  };

  // 凭据字段展示名（轮142 C）。两张表不能混用：小凭据的 password 是 Nacos 密码，大凭据的 password 是 SSH 口令。
  const connectionSecretLabel = (field: string) => t(CONNECTION_SECRET_LABEL_KEYS[field as ConnectionSecretField]);
  const sshSecretLabel = (field: string) => t(SSH_SECRET_LABEL_KEYS[field as SSHSecretField]);
  const joinFieldNames = (names: string[]) => Array.from(new Set(names)).join(" / ");

  /**
   * 打开表单读回凭据后的就近说明（轮142 C）：
   * 读不回来必须说——否则用户以为「这条连接的密码本来就是空的」，抄一遍别处的密码盖上；
   * 读回来了也要说一句，免得有人把这些值当本地数据拷走（它其实只在内存里）。
   */
  const secretHydrationMessage = (
    groups: {
      fields: readonly string[];
      values: Record<string, string>;
      unavailable: { field: string }[];
      labelOf: (field: string) => string;
      inlineValueOf: (field: string) => string;
    }[]
  ): { ok: boolean; text: string } | null => {
    const unreadable: string[] = [];
    const loaded: string[] = [];
    for (const group of groups) {
      for (const field of group.fields) {
        if ((group.values[field] ?? "") && !group.inlineValueOf(field)) loaded.push(group.labelOf(field));
      }
      for (const notice of group.unavailable) unreadable.push(group.labelOf(notice.field));
    }
    if (unreadable.length > 0) {
      return { ok: false, text: t("credentials.editUnreadable", { fields: joinFieldNames(unreadable) }) };
    }
    if (loaded.length > 0) {
      return { ok: true, text: t("credentials.editLoaded", { fields: joinFieldNames(loaded) }) };
    }
    return null;
  };

  // 凭据来源的就近说明（轮142 C）：值在系统凭据库里、本地数据只剩指针时，得说清「这里不是空的」。
  const secretSourceNote = (labels: string[]) =>
    labels.length === 0 ? null : (
      <div className="settings-panel-note secret-source-note">
        {t("credentials.vaultNote", { fields: joinFieldNames(labels) })}
      </div>
    );
  const storedConnectionSecretLabels = (fields: readonly ConnectionSecretField[]) =>
    fields.filter((field) => draft.secretRefs?.[field]?.status === "stored").map((field) => t(CONNECTION_SECRET_LABEL_KEYS[field]));
  const storedSSHSecretLabels = (fields: readonly SSHSecretField[]) =>
    fields.filter((field) => draft.sshSecretRefs?.[field]?.status === "stored").map((field) => t(SSH_SECRET_LABEL_KEYS[field]));

  const startNew = (projectName = activeProject, environmentName = activeEnvironment) => {
    openSeqRef.current += 1;
    const next = {
      ...emptyDraft(defaultNewEnvironment),
      projectName: projectName || DEFAULT_PROJECT_NAME,
      environmentName: environmentName || defaultNewEnvironment,
    };
    setActiveProject(next.projectName ?? DEFAULT_PROJECT_NAME);
    setActiveEnvironment(next.environmentName ?? defaultNewEnvironment);
    setDraft(next);
    setCreatingProject(!projectOptions.includes((next.projectName ?? "").trim()));
    setTestMsg(null);
    setNamespaceResultKey(null);
    setNamespaceOptions([]);
    setNamespaceError(null);
    setConfirmDel(null);
    setShowSSHConfig(false);
  };

  /**
   * 打开一条连接的编辑表单（轮142 C）。凭据迁到系统库后本地只剩指针，必须先把值读回内存草稿，
   * 否则点开一条迁过的连接看到的是空密码/空 AK-SK——和隧道档案同一个根因。
   * 读库失败不阻断编辑：那一条留空 + 提示重新填写，其余字段照常可改可存。
   */
  const openConnection = async (c: Connection) => {
    const seq = (openSeqRef.current += 1);
    const [secrets, sshSecrets] = await Promise.all([
      loadConnectionSecretsForEdit(c),
      loadSSHSecretsForEdit(c.sshConfig, c.sshSecretRefs),
    ]);
    if (openSeqRef.current !== seq) return;
    setActiveProject(connectionProjectName(c));
    setActiveEnvironment(connectionEnvironmentName(c));
    setDraft({
      ...c,
      ...connectionSecretPatch(secrets.values),
      sshConfig: c.sshConfig ? { ...c.sshConfig, ...sshSecretPatch(sshSecrets.values) } : c.sshConfig,
      secretBaseline: secrets.baseline,
      sshSecretBaseline: sshSecrets.baseline,
    });
    setCreatingProject(!projectOptions.includes(connectionProjectName(c)));
    setTestMsg(null);
    setNamespaceResultKey(null);
    setNamespaceOptions([]);
    setNamespaceError(null);
    setLocalValidation(
      c.localValidation
        ? {
            valid: c.localValidation.valid,
            path: c.localPath ?? "",
            code: c.localValidation.code ?? "",
            message: c.localValidation.message,
            configCount: c.localValidation.configCount,
            schemaVersion: c.localValidation.schemaVersion ?? 0,
            layout: c.localValidation.layout ?? "",
            legacy: c.localValidation.legacy ?? false,
            hasManifest: false,
            matchedMarkers: [],
            checkedAt: c.localValidation.checkedAt,
          }
        : null
    );
    setConfirmDel(null);
    setShowSSHConfig(!!c.sshConfig?.host || !!c.sshProfileId);
    const message = secretHydrationMessage([
      {
        fields: CONNECTION_SECRET_FIELDS,
        values: secrets.values,
        unavailable: secrets.unavailable,
        labelOf: connectionSecretLabel,
        inlineValueOf: (field) => (c as unknown as Record<string, string | undefined>)[field] ?? "",
      },
      {
        fields: SSH_SECRET_FIELDS,
        values: sshSecrets.values,
        unavailable: sshSecrets.unavailable,
        labelOf: sshSecretLabel,
        inlineValueOf: (field) => c.sshConfig?.[field as SSHSecretField] ?? "",
      },
    ]);
    if (message) setTestMsg(message);
  };

  const edit = (c: Connection) => {
    void openConnection(c);
  };

  const duplicateConnection = async (c: Connection) => {
    const sourceName = copyLabel(connectionSourceName(c), t("connection.sourceName"), t("connection.copySuffix"));
    const label = copyLabel(c.name, sourceName, t("connection.copySuffix"));
    const seq = (openSeqRef.current += 1);
    const [secrets, sshSecrets] = await Promise.all([
      loadConnectionSecretsForEdit(c),
      loadSSHSecretsForEdit(c.sshConfig, c.sshSecretRefs),
    ]);
    if (openSeqRef.current !== seq) return;
    setActiveProject(connectionProjectName(c));
    setActiveEnvironment(connectionEnvironmentName(c));
    setDraft({
      ...c,
      id: undefined,
      name: label,
      sourceName,
      isDefaultSource: false,
      ...connectionSecretPatch(secrets.values),
      sshConfig: c.sshConfig ? { ...c.sshConfig, ...sshSecretPatch(sshSecrets.values) } : c.sshConfig,
      /*
       * 复制件不带源记录的指针（轮142 C 的第三种形状）：指针的 ownerId 是源连接，
       * 新连接攥着它既读不到、normalize 也不报错，凭据等于凭空丢。
       * 明文铺进内联草稿＝迁移前的老形状，保存时由「迁移凭据」按新 id 重新入库。
       */
      secretRefs: undefined,
      sshSecretRefs: undefined,
      secretBaseline: {},
      sshSecretBaseline: {},
    });
    setCreatingProject(!projectOptions.includes(connectionProjectName(c)));
    setTestTrace(null);
    setTestResultKey(null);
    setTestingKey(null);
    setNamespaceResultKey(null);
    setNamespaceOptions([]);
    setNamespaceError(null);
    setLocalValidation(
      c.localValidation
        ? {
            valid: c.localValidation.valid,
            path: c.localPath ?? "",
            code: c.localValidation.code ?? "",
            message: c.localValidation.message,
            configCount: c.localValidation.configCount,
            schemaVersion: c.localValidation.schemaVersion ?? 0,
            layout: c.localValidation.layout ?? "",
            legacy: c.localValidation.legacy ?? false,
            hasManifest: false,
            matchedMarkers: [],
            checkedAt: c.localValidation.checkedAt,
          }
        : null
    );
    setConfirmDel(null);
    setShowSSHConfig(!!c.sshConfig?.host || !!c.sshProfileId);
    const message = secretHydrationMessage([
      {
        fields: CONNECTION_SECRET_FIELDS,
        values: secrets.values,
        unavailable: secrets.unavailable,
        labelOf: connectionSecretLabel,
        inlineValueOf: (field) => (c as unknown as Record<string, string | undefined>)[field] ?? "",
      },
      {
        fields: SSH_SECRET_FIELDS,
        values: sshSecrets.values,
        unavailable: sshSecrets.unavailable,
        labelOf: sshSecretLabel,
        inlineValueOf: (field) => c.sshConfig?.[field as SSHSecretField] ?? "",
      },
    ]);
    setTestMsg(message ?? { ok: true, text: t("connection.copyReady") });
  };

  const selectContext = (projectName: string, environmentName?: string) => {
    setActiveProject(projectName);
    setCreatingProject(false);
    if (environmentName) setActiveEnvironment(environmentName);
    if (!draft.id) {
      setDraft((d) => ({
        ...d,
        projectName,
        environmentName: environmentName ?? d.environmentName ?? DEFAULT_ENVIRONMENT_NAME,
      }));
    }
  };

  const commitProjectRename = () => {
    if (!renamingProject) return;
    const nextName = renamingProject.value.trim();
    if (!nextName) {
      setRenamingProject(null);
      return;
    }
    const next = renameProject(renamingProject.oldName, nextName);
    setList(next);
    onChange(next);
    if (activeProject === renamingProject.oldName) setActiveProject(nextName);
    setDraft((d) => ({
      ...d,
      projectName: (d.projectName ?? DEFAULT_PROJECT_NAME) === renamingProject.oldName ? nextName : d.projectName,
    }));
    setRenamingProject(null);
  };

  // 端口非法的唯一判据（R24）：输入框下的行内错误、保存按钮的禁用与 title、save() 的拦截都读它，
  // 三处不会各说一套。留空不在这一步报错——失焦时会回弹默认端口，用户敲字中途看到红字只会碍事。
  const portBlock = sshPortIssues(draft.sshConfig, {
    port: t("connection.sshPort"),
    localPort: t("connection.localPortShort"),
  })[0];

  const save = async () => {
    // 按钮 disabled 拦不住「单行输入框回车＝保存」那条路径，这里再兜一道；
    // 清掉旧测试结果，否则这条理由会被当成上一次测试的残留而看不见。
    if (portBlock) {
      setTestTrace(null);
      setTestResultKey(null);
      setTestMsg({ ok: false, text: portBlock });
      return;
    }
    if (!draft.sourceName?.trim() || (draft.provider !== "local" && !draft.baseUrl.trim())) {
      setTestMsg({ ok: false, text: t("connection.nameAndAddressRequired") });
      return;
    }
    if (draft.provider === "local") {
      if (!draft.localPath?.trim()) {
        setTestMsg({ ok: false, text: t("connection.localPathRequired") });
        return;
      }
      if (!draft.forceLocalSnapshot && (!localValidation?.valid || localValidation.path !== draft.localPath.trim())) {
        setTestMsg({ ok: false, text: t("connection.localValidationRequired") });
        return;
      }
    }
    if (draft.provider === "apollo") {
      if (!draft.apolloToken?.trim() || !draft.apolloAppId?.trim() || !draft.apolloCluster?.trim() || !draft.apolloNamespaceName?.trim()) {
        setTestMsg({ ok: false, text: t("connection.apolloRequired") });
        return;
      }
    }
    // SSH 配置：host 为空则不保存
    const toSave = { ...draft };
    if (toSave.sshProfileId) {
      toSave.sshConfig = undefined;
    }
    if (toSave.sshConfig && !toSave.sshConfig.host?.trim()) {
      toSave.sshConfig = undefined;
    } else if (toSave.sshConfig) {
      const { remoteHost: _remoteHost, remotePort: _remotePort, ...sshConfig } = toSave.sshConfig;
      toSave.sshConfig = sshConfig;
    }

    /*
     * 凭据结算（轮142 C）：编辑已有连接才走「没动/改过/清空」三路判定——表单里带着从系统库读回的
     * 明文，直接整份落盘就等于把刚迁走的凭据又拉回本地文件，静默退回一次迁移。
     * 新建连接此刻还没有 id、指针没有归属，沿用迁移前的老形状（明文内联，由设置页「迁移凭据」统一入库）。
     */
    let settleFailed: string | null = null;
    if (draft.id) {
      const noticeParts: string[] = [];
      const collectNotices = (notices: SecretEditNotice[], labelOf: (field: string) => string) => {
        for (const kind of ["write", "delete"] as const) {
          const names = notices.filter((item) => item.kind === kind).map((item) => labelOf(item.field));
          if (names.length === 0) continue;
          noticeParts.push(
            t(kind === "write" ? "credentials.editWriteFailed" : "credentials.editDeleteFailed", {
              fields: joinFieldNames(names),
            })
          );
        }
      };
      const settledConnection = await settleConnectionSecrets({
        ownerId: draft.id,
        draft: toSave,
        baseline: draft.secretBaseline ?? {},
        refs: toSave.secretRefs,
      });
      Object.assign(toSave, connectionSecretPatch(settledConnection.inline));
      toSave.secretRefs = settledConnection.pointers;
      collectNotices(settledConnection.notices, connectionSecretLabel);

      if (toSave.sshConfig) {
        const settledSSH = await settleSSHSecrets({
          namespace: "connection-ssh",
          ownerId: draft.id,
          draft: toSave.sshConfig,
          baseline: draft.sshSecretBaseline ?? {},
          refs: toSave.sshSecretRefs,
        });
        toSave.sshConfig = { ...toSave.sshConfig, ...sshSecretPatch(settledSSH.inline) };
        toSave.sshSecretRefs = settledSSH.pointers;
        collectNotices(settledSSH.notices, sshSecretLabel);
      } else {
        // 改用档案、或 host 空到不存 SSH 配置：连接自己那份大凭据指针不再留着。
        toSave.sshSecretRefs = undefined;
      }
      settleFailed = noticeParts.join("；") || null;
    } else {
      toSave.secretRefs = undefined;
      toSave.sshSecretRefs = undefined;
    }

    const sourceName = toSave.sourceName?.trim() || toSave.name.trim();
    const connectionName = toSave.name.trim() || sourceName;
    const saved = upsertConnection({
      ...toSave,
      name: connectionName,
      projectName: toSave.projectName?.trim() || DEFAULT_PROJECT_NAME,
      environmentName: toSave.environmentName?.trim() || DEFAULT_ENVIRONMENT_NAME,
      envRole: toSave.envRole || undefined,
      writeConfirmPolicy: toSave.writeConfirmPolicy || undefined,
      sourceName,
      sourceType: toSave.sourceType ?? "nacos",
      localPath: toSave.localPath?.trim() || "",
      forceLocalSnapshot: !!toSave.forceLocalSnapshot,
      localValidation: localValidation
        ? {
            valid: localValidation.valid,
            code: localValidation.code,
            message: localValidation.message,
            configCount: localValidation.configCount,
            schemaVersion: localValidation.schemaVersion,
            layout: localValidation.layout,
            legacy: localValidation.legacy,
            checkedAt: localValidation.checkedAt,
          }
        : undefined,
      baseUrl: toSave.sourceType === "local-snapshot" ? toSave.localPath?.trim() || "" : toSave.baseUrl.trim(),
      defaultNamespace: providerDefaultNamespace(toSave),
      defaultGroup: toSave.provider === "nacos" ? (toSave.defaultGroup ?? "").trim() : "",
      apolloEnv: toSave.apolloEnv?.trim() || "",
      apolloAppId: toSave.apolloAppId?.trim() || "",
      apolloCluster: toSave.apolloCluster?.trim() || "",
      apolloNamespaceName: toSave.apolloNamespaceName?.trim() || "",
      apolloToken: toSave.apolloToken ?? "",
      consulToken: toSave.consulToken ?? "",
      consulDatacenter: toSave.consulDatacenter?.trim() || "",
      consulKeyPrefix: toSave.consulKeyPrefix?.trim() || "",
    });
    clearToken(saved.id, saved.baseUrl); // 凭据/地址可能变了，清掉旧 token 与版本缓存
    const savedProject = connectionProjectName(saved);
    const savedEnvironment = connectionEnvironmentName(saved);
    setActiveProject(savedProject);
    setActiveEnvironment(savedEnvironment);
    setDraft({ ...emptyDraft(defaultNewEnvironment), projectName: savedProject, environmentName: savedEnvironment });
    setShowSSHConfig(false);
    setLocalValidation(null);
    refresh();
    if (settleFailed) {
      // 连接存下了，但有几个字段没能进系统凭据库：说清「这次是明文存在本地」，别只报成功。
      setTestTrace(null);
      setTestResultKey(null);
      setTestMsg({ ok: false, text: settleFailed });
    }
  };

  // 第一次点 × 进入确认态，再次点击才真正删除。
  const askOrRemove = (id: string) => {
    if (confirmDel !== id) {
      setConfirmDel(id);
      return;
    }
    const target = list.find((c) => c.id === id);
    deleteConnection(id);
    clearToken(id, target?.baseUrl);
    if (draft.id === id) setDraft(emptyDraft(defaultNewEnvironment));
    setConfirmDel(null);
    refresh();
  };

  const doTest = async () => {
    // 保存按钮禁用后用户仍能点「连接测试」，这一道拦截保证越界端口不会静默发给后端。
    // 顺手清掉 testResultKey，否则上一次测试的 key 还挂着，这条理由会被当成旧结果藏起来看不见。
    if (portBlock) {
      setTestTrace(null);
      setTestResultKey(null);
      setTestMsg({ ok: false, text: portBlock });
      return;
    }
    const startedAt = Date.now();
    const snapshot: Draft = {
      ...draft,
      defaultGroup: draft.provider === "nacos" ? (draft.defaultGroup ?? "").trim() : "",
      defaultNamespace: providerDefaultNamespace(draft),
      tags: [...(draft.tags ?? [])],
      sshConfig: draft.sshConfig ? { ...draft.sshConfig } : undefined,
    };
    const snapshotKey = connectionTestKey(snapshot);
    setTestTrace(null);
    setTestMsg(null);
    setTestResultKey(snapshotKey);

    if (snapshot.sourceType === "local-snapshot") {
      await validateLocalSnapshotPath(snapshot.localPath?.trim() ?? "", true, startedAt, snapshotKey);
      return;
    }
    setTestingKey(snapshotKey);
    try {
      if (snapshot.provider === "apollo" || snapshot.provider === "consul" || snapshot.authType === "aliyun-aksk" || snapshot.username) {
        const r = await testConnection({ ...(snapshot as Connection), id: snapshot.id ?? "test" });
        if (currentTestKeyRef.current !== snapshotKey) return;
        const latency = latencyText(t, startedAt);
        setTestMsg({
          ok: true,
          text: r.globalAdmin ? t("connection.testConnectedAdmin", { latency }) : t("connection.testConnected", { latency }),
        });
        setTestTrace(
          buildConnectionTrace(
            snapshot,
            startedAt,
            true,
            r.globalAdmin ? t("connection.traceConnectedAdmin") : t("connection.traceConnected"),
            t
          )
        );
      } else {
        // 无账号：尝试无鉴权访问命名空间接口验证可达性
        if (currentTestKeyRef.current !== snapshotKey) return;
        setTestMsg({
          ok: true,
          text: t("connection.testConnectedNoAuth", { latency: latencyText(t, startedAt) }),
        });
        setTestTrace(buildConnectionTrace(snapshot, startedAt, true, t("connection.traceConnectedNoAuth"), t));
      }
    } catch (e) {
      if (currentTestKeyRef.current !== snapshotKey) return;
      const message = errorText(e);
      setTestMsg({ ok: false, text: t("connection.testFailedWithLatency", { message, latency: latencyText(t, startedAt) }) });
      setTestTrace(buildConnectionTrace(snapshot, startedAt, false, message, t));
    } finally {
      setTestingKey((current) => (current === snapshotKey ? null : current));
    }
  };

  const loadDefaultNamespaceOptions = async () => {
    if (draft.provider === "local") return;
    if (!draft.baseUrl.trim()) {
      setNamespaceResultKey(currentNamespaceKey);
      setNamespaceOptions([]);
      setNamespaceError(t("connection.addressRequired"));
      return;
    }

    const snapshot: Draft = {
      ...draft,
      tags: [...(draft.tags ?? [])],
      sshConfig: draft.sshConfig ? { ...draft.sshConfig } : undefined,
    };
    const snapshotKey = namespaceLoadKey(snapshot);
    currentNamespaceKeyRef.current = snapshotKey;
    setNamespaceLoadingKey(snapshotKey);
    setNamespaceResultKey(snapshotKey);
    setNamespaceOptions([]);
    setNamespaceError(null);

    try {
      const items = await listNamespaces({ ...(snapshot as Connection), id: snapshot.id ?? "namespace-preview" });
      if (currentNamespaceKeyRef.current !== snapshotKey) return;
      setNamespaceOptions(items);
      setNamespaceError(null);
    } catch (e) {
      if (currentNamespaceKeyRef.current !== snapshotKey) return;
      setNamespaceOptions([]);
      setNamespaceError(errorText(e));
    } finally {
      setNamespaceLoadingKey((current) => (current === snapshotKey ? null : current));
    }
  };

  const validateLocalSnapshotPath = async (
    path: string,
    showLatency = false,
    startedAt = Date.now(),
    resultKey = connectionTestKey(draft)
  ) => {
    setTestResultKey(resultKey);
    if (!path) {
      setTestMsg({ ok: false, text: t("connection.localPathRequired") });
      return null;
    }
    setValidatingLocal(true);
    setTestMsg(null);
    try {
      const result = await validateLocalSnapshotDirectory(path);
      if (currentTestKeyRef.current !== resultKey) return null;
      setLocalValidation(result);
      setTestMsg({
        ok: result.valid,
        text: localSnapshotValidationMessage(result, t) + (showLatency ? `（${latencyText(t, startedAt)}）` : ""),
      });
      return result;
    } catch (e) {
      if (currentTestKeyRef.current !== resultKey) return null;
      setTestMsg({ ok: false, text: errorText(e) });
      return null;
    } finally {
      setValidatingLocal(false);
    }
  };

  const doSelectLocalSnapshotDirectory = async () => {
    setSelectingLocalDir(true);
    setTestMsg(null);
    try {
      const path = await selectLocalSnapshotDirectory();
      if (path) {
        const nextDraft = { ...draft, localPath: path, baseUrl: path };
        const nextKey = connectionTestKey(nextDraft);
        currentTestKeyRef.current = nextKey;
        setDraft(nextDraft);
        setLocalValidation(null);
        await validateLocalSnapshotPath(path.trim(), false, Date.now(), nextKey);
      }
    } catch (e) {
      setTestMsg({ ok: false, text: errorText(e) });
    } finally {
      setSelectingLocalDir(false);
    }
  };

  const doValidateLocalSnapshot = async (showLatency = false, startedAt = Date.now()) => {
    await validateLocalSnapshotPath(draft.localPath?.trim() ?? "", showLatency, startedAt);
  };

  const fieldLabelProps = {
    onHelpShow: setHelpPopover,
    onHelpHide: () => setHelpPopover(null),
  };

  const content = (
    <>
      <div className={embedded ? "page-header" : "modal-header"}>
        <div>
          <h3 id={titleId}>{t("connection.title")}</h3>
          {embedded && <div className="page-subtitle">{t("connection.pageSubtitle")}</div>}
        </div>
        {!embedded && (
          <button className="modal-x" onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
            ×
          </button>
        )}
      </div>

      <div className={embedded ? "conn-mgr conn-mgr-page" : "modal-body conn-mgr"}>
        <div className="conn-list">
          <div className="conn-list-title">{t("connection.savedConnections")}</div>
          <button className="btn btn-primary btn-sm conn-create-btn" onClick={() => startNew()}>
            {t("connection.addSource")}
          </button>
          {list.length === 0 && <div className="conn-empty">{t("connection.noConnections")}</div>}
          {groupedConnections.map((project) => (
            <div className="conn-group" key={project.project}>
              <div
                className={`conn-group-title${activeProject === project.project ? " active" : ""}`}
                onClick={() => selectContext(project.project)}
                {...clickableRowProps(() => selectContext(project.project), { role: "group", selected: activeProject === project.project })}
              >
                {renamingProject?.oldName === project.project ? (
                  <input
                    type="text"
                    className="conn-inline-input"
                    aria-label={t("connection.renameProject")}
                    value={renamingProject.value}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenamingProject({ ...renamingProject, value: e.target.value })}
                    onBlur={commitProjectRename}
                    onKeyDown={(e) => {
                      // 组合态的 Enter 属于输入法（上屏候选），不能提交重命名；
                      // Esc 已改由分层注册表接管（R61），这里的裸分支在捕获阶段就被吃掉，是死代码
                      if (isImeComposing(e)) return;
                      if (e.key === "Enter") commitProjectRename();
                    }}
                  />
                ) : (
                  <span className="conn-group-name" title={project.project}>
                    {project.project}
                  </span>
                )}
                <div className="conn-tree-actions">
                  <button
                    className="conn-tree-btn"
                    title={t("connection.addSourceToProject", { name: project.project })}
                    aria-label={t("connection.addSourceToProject", { name: project.project })}
                    onClick={(e) => {
                      e.stopPropagation();
                      startNew(project.project, project.environments[0]?.environment ?? DEFAULT_ENVIRONMENT_NAME);
                    }}
                  >
                    +
                  </button>
                  <button
                    className="conn-tree-btn"
                    title={t("connection.renameProject")}
                    aria-label={t("connection.renameProject")}
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenamingProject({ oldName: project.project, value: project.project });
                    }}
                  >
                    ✎
                  </button>
                </div>
              </div>
              {project.environments.map((env) => (
                <div className="conn-env-group" key={`${project.project}/${env.environment}`}>
                  <div
                    className={`conn-env-title${
                      activeProject === project.project && activeEnvironment === env.environment ? " active" : ""
                    }`}
                    onClick={() => selectContext(project.project, env.environment)}
                    {...clickableRowProps(() => selectContext(project.project, env.environment), {
                      role: "group",
                      selected: activeProject === project.project && activeEnvironment === env.environment,
                    })}
                  >
                    <span className="conn-env-name" title={env.environment}>
                      {env.environment}
                    </span>
                    <div className="conn-tree-actions">
                      <button
                        className="conn-tree-btn"
                        title={t("connection.addSourceToEnv", { name: env.environment })}
                        aria-label={t("connection.addSourceToEnv", { name: env.environment })}
                        onClick={(e) => {
                          e.stopPropagation();
                          startNew(project.project, env.environment);
                        }}
                      >
                        +
                      </button>
                    </div>
                  </div>
                  {env.connections.map((c) => (
                    <div
                      key={c.id}
                      className={`conn-item${draft.id === c.id ? " active" : ""}`}
                      onClick={() => edit(c)}
                      {...clickableRowProps(() => edit(c), { role: "group", selected: draft.id === c.id })}
                    >
                      <div className="conn-item-main">
                        <div className="conn-item-name">
                          {sourceLabel(c, t)}
                          {c.isDefaultSource && <span className="conn-ssh-badge">{t("connection.defaultSource")}</span>}
                          <span
                            className={`env-badge env-${environmentTone(connectionEnvironmentName(c))}`}
                            title={localizeDefaultName(connectionEnvironmentName(c), t)}
                          >
                            {localizeDefaultName(connectionEnvironmentName(c), t)}
                          </span>
                          {c.provider === "nacos" && <span className="conn-provider-badge nacos">Nacos</span>}
                          {c.provider === "apollo" && <span className="conn-provider-badge apollo">Apollo</span>}
                          {c.provider === "consul" && <span className="conn-provider-badge consul">Consul</span>}
                          {c.provider === "local" && (
                            <span className="conn-provider-badge local">{t("connection.sourceTypeSnapshot")}</span>
                          )}
                          {(c.sshConfig || c.sshProfileId) && (
                            <span className="conn-ssh-badge" title={t("connection.sshConfig")}>
                              <SshLockIcon />
                              SSH
                            </span>
                          )}
                        </div>
                        <div className="conn-item-url">
                          <span>{sourceAddress(c)}</span>
                          {connectionLabelMeta(c) && (
                            <span>
                              {t("connection.connectionLabelShort")}: {connectionLabelMeta(c)}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="conn-item-actions">
                        <button
                          className="conn-item-action"
                          title={t("connection.copy")}
                          aria-label={t("connection.copy")}
                          onClick={(e) => {
                            e.stopPropagation();
                            void duplicateConnection(c);
                          }}
                        >
                          ⧉
                        </button>
                        {confirmDel === c.id ? (
                          <button
                            className="conn-item-del confirm"
                            title={t("connection.confirmDelete")}
                            onClick={(e) => {
                              e.stopPropagation();
                              askOrRemove(c.id);
                            }}
                          >
                            {t("connection.deleteConfirm")}
                          </button>
                        ) : (
                          <button
                            className="conn-item-del"
                            title={t("common.delete")}
                            aria-label={t("common.delete")}
                            onClick={(e) => {
                              e.stopPropagation();
                              askOrRemove(c.id);
                            }}
                          >
                            ×
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div
          className="conn-form"
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            // 组合态回车是把候选词上屏到当前字段，不是提交整个表单
            if (isImeComposing(e)) return;
            // 只有单行文本框回车才等价于「保存」。
            // 私钥输入框是 <textarea>（PEM 要整段粘贴、必须能换行），
            // 按钮 / 链接 / 下拉 / 复选框自带 Enter 语义，容器都不该替它们吃掉这次按键。
            if (!isSingleLineTextField(e.target)) return;
            e.preventDefault();
            void save();
          }}
        >
          <div className="conn-form-title">{draft.id ? t("connection.edit") : t("connection.new")}</div>
          {helpPopover && (
            <div className="help-popover" style={{ top: helpPopover.top, left: helpPopover.left }}>
              {helpPopover.text}
            </div>
          )}

          <section className="conn-form-section">
            <div className="conn-section-title">{t("connection.sectionBasic")}</div>
            <div className="field-row">
              <label className="field">
                <FieldLabel id={projectCaptionId} {...fieldLabelProps} required tip={t("connection.projectHelp")}>
                  {t("connection.project")}
                </FieldLabel>
                {projectOptions.length > 0 && (
                  <select
                    className="search-input wide"
                    aria-labelledby={projectCaptionId}
                    value={selectedProjectOption}
                    onChange={(e) => {
                      if (e.target.value === "__new__") {
                        setCreatingProject(true);
                        set({ projectName: "" });
                        return;
                      }
                      setCreatingProject(false);
                      set({ projectName: e.target.value });
                    }}
                  >
                    {projectOptions.map((name) => (
                      <option value={name} key={name}>
                        {name}
                      </option>
                    ))}
                    <option value="__new__">{t("connection.projectNewOption")}</option>
                  </select>
                )}
                {showProjectInput && (
                  <input
                    type="text"
                    className="search-input wide"
                    aria-labelledby={projectCaptionId}
                    value={draft.projectName ?? ""}
                    placeholder={t("connection.projectPlaceholder")}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => set({ projectName: e.target.value })}
                  />
                )}
              </label>
              <label className="field">
                <FieldLabel {...fieldLabelProps} required tip={t("connection.environmentHelp")}>
                  {t("connection.environment")}
                </FieldLabel>
                <select
                  className="search-input wide"
                  value={draft.environmentName ?? ""}
                  onChange={(e) => set({ environmentName: e.target.value })}
                >
                  {environmentOptions.map((name) => (
                    <option value={name} key={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <FieldLabel {...fieldLabelProps} tip={t("connection.envRoleHelp")}>
                  {t("connection.envRole")}
                </FieldLabel>
                <select
                  className="search-input wide"
                  value={draft.envRole ?? ""}
                  onChange={(e) => set({ envRole: (e.target.value || undefined) as Draft["envRole"] })}
                >
                  <option value="">{t("connection.envRoleUndeclared")}</option>
                  <option value="development">{t("connection.envRoleDevelopment")}</option>
                  <option value="testing">{t("connection.envRoleTesting")}</option>
                  <option value="staging">{t("connection.envRoleStaging")}</option>
                  <option value="production">{t("connection.envRoleProduction")}</option>
                </select>
              </label>
              <label className="field">
                <FieldLabel {...fieldLabelProps} tip={t("connection.writeConfirmPolicyHelp")}>
                  {t("connection.writeConfirmPolicy")}
                </FieldLabel>
                <select
                  className="search-input wide"
                  value={draft.writeConfirmPolicy ?? ""}
                  onChange={(e) => set({ writeConfirmPolicy: (e.target.value || undefined) as Draft["writeConfirmPolicy"] })}
                >
                  <option value="">{t("connection.writeConfirmPolicyUndeclared")}</option>
                  <option value="always">{t("connection.writeConfirmPolicyAlways")}</option>
                  <option value="protected-only">{t("connection.writeConfirmPolicyProtectedOnly")}</option>
                  <option value="never">{t("connection.writeConfirmPolicyNever")}</option>
                </select>
              </label>
            </div>
          </section>

          <section className="conn-form-section">
            <div className="conn-section-title">{t("connection.sectionNetwork")}</div>
            <div className="field-row">
              <label className="field">
                <FieldLabel {...fieldLabelProps} required tip={t("connection.sourceNameHelp")}>
                  {t("connection.sourceName")}
                </FieldLabel>
                <input
                  type="text"
                  className="search-input wide"
                  value={draft.sourceName ?? ""}
                  placeholder={t("connection.sourceNamePlaceholder")}
                  autoFocus
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => set({ sourceName: e.target.value })}
                />
              </label>
              <label className="field check-field">
                <FieldLabel {...fieldLabelProps} tip={t("connection.defaultSourceHelp")}>
                  {t("connection.defaultSource")}
                </FieldLabel>
                <input type="checkbox" checked={!!draft.isDefaultSource} onChange={(e) => set({ isDefaultSource: e.target.checked })} />
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <FieldLabel {...fieldLabelProps} tip={t("connection.sourcePresetHelp")}>
                  {t("connection.sourcePreset")}
                </FieldLabel>
                <select
                  className="search-input wide"
                  value={selectedSourcePreset}
                  onChange={(e) => {
                    const preset = sourceNamePresets.find((item) => item.label === e.target.value);
                    if (!preset) return;
                    setDraft((d) => ({ ...d, sourceName: preset.label }));
                    setAccessMode(preset.mode);
                  }}
                >
                  <option value="">{t("connection.sourcePresetCustom")}</option>
                  {sourceNamePresets.map((item) => (
                    <option value={item.label} key={item.label}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <FieldLabel {...fieldLabelProps} required tip={t("connection.providerHelp")}>
                  {t("connection.provider")}
                </FieldLabel>
                <select
                  className="search-input wide"
                  value={draft.provider ?? "nacos"}
                  onChange={(e) => setProvider(e.target.value as Draft["provider"])}
                >
                  <option value="nacos">Nacos</option>
                  <option value="apollo">Apollo</option>
                  <option value="consul">Consul</option>
                  <option value="local">{t("connection.sourceTypeSnapshot")}</option>
                </select>
              </label>
            </div>
            {draft.provider === "local" && (
              <label className="field">
                <FieldLabel id={localPathCaptionId} {...fieldLabelProps} required tip={t("connection.localPathHelp")}>
                  {t("connection.localPath")}
                </FieldLabel>
                <div className="path-field">
                  <input
                    type="text"
                    className="search-input wide mono"
                    aria-labelledby={localPathCaptionId}
                    value={draft.localPath ?? ""}
                    placeholder={t("connection.localPathPlaceholder")}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => set({ localPath: e.target.value, baseUrl: e.target.value })}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={doSelectLocalSnapshotDirectory}
                    disabled={selectingLocalDir}
                  >
                    {selectingLocalDir ? t("connection.selectingFolder") : t("connection.selectFolder")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => doValidateLocalSnapshot()}
                    disabled={validatingLocal}
                  >
                    {validatingLocal ? t("connection.validatingLocal") : t("connection.validateLocal")}
                  </button>
                </div>
                <div className="field-hint">{t("connection.localPathStructureHint")}</div>
                <label className="force-local-field">
                  <input
                    type="checkbox"
                    checked={!!draft.forceLocalSnapshot}
                    onChange={(e) => set({ forceLocalSnapshot: e.target.checked })}
                  />
                  <span>{t("connection.forceLocalSnapshot")}</span>
                </label>
                {draft.forceLocalSnapshot && (
                  <div className="field-warning" {...statusMessageProps("info")}>
                    {t("connection.forceLocalSnapshotHelp")}
                  </div>
                )}
                {localValidation && (
                  <div className={`local-validation ${localValidation.valid ? "ok" : "err"}`}>
                    {localValidation.valid
                      ? t("connection.localValidationOk").replace("{count}", String(localValidation.configCount))
                      : localSnapshotValidationMessage(localValidation, t)}
                    <span className="local-validation-path">{localValidation.path}</span>
                  </div>
                )}
              </label>
            )}
            <label className="field">
              <FieldLabel {...fieldLabelProps} tip={t("connection.nameHelp")}>
                {t("connection.name")}
              </FieldLabel>
              <input
                type="text"
                className="search-input wide"
                value={draft.name}
                placeholder={t("connection.namePlaceholder")}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => set({ name: e.target.value })}
              />
            </label>
          </section>
          {draft.provider === "nacos" && (
            <section className="conn-form-section">
              <div className="conn-section-title">{t("connection.sectionAuth")}</div>
              <div className="field-row">
                <label className="field">
                  <FieldLabel {...fieldLabelProps} required tip={t("connection.distributionHelp")}>
                    {t("connection.distribution")}
                  </FieldLabel>
                  <select
                    className="search-input wide"
                    value={draft.distribution ?? "opensource"}
                    onChange={(e) => setDistribution(e.target.value as Draft["distribution"])}
                  >
                    <option value="opensource">{t("connection.opensourceNacos")}</option>
                    <option value="aliyun-mse">{t("connection.aliyunMseNacos")}</option>
                  </select>
                </label>
                <label className="field">
                  <FieldLabel {...fieldLabelProps} required tip={t("connection.accessModeHelp")}>
                    {t("connection.accessMode")}
                  </FieldLabel>
                  <select
                    className="search-input wide"
                    value={accessMode}
                    onChange={(e) => setAccessMode(e.target.value as "direct" | "ssh")}
                  >
                    <option value="direct">{t("connection.accessModeDirect")}</option>
                    <option value="ssh">{t("connection.accessModeSsh")}</option>
                  </select>
                </label>
              </div>
              <label className="field">
                <FieldLabel {...fieldLabelProps} required tip={t("connection.addressHelp")}>
                  {t("connection.address")}
                </FieldLabel>
                <input
                  type="text"
                  className="search-input wide mono"
                  value={draft.baseUrl}
                  placeholder="http://localhost:8848/nacos"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => set({ baseUrl: e.target.value })}
                />
              </label>
              <label className="field">
                <FieldLabel {...fieldLabelProps} required tip={t("connection.authTypeHelp")}>
                  {t("connection.authType")}
                </FieldLabel>
                <select
                  className="search-input wide"
                  value={draft.authType ?? "nacos-password"}
                  onChange={(e) => set({ authType: e.target.value as Draft["authType"] })}
                >
                  <option value="none">{t("connection.noAuth")}</option>
                  <option value="nacos-password">{t("connection.nacosPasswordAuth")}</option>
                  <option value="aliyun-aksk">{t("connection.aliyunAKSKAuth")}</option>
                </select>
              </label>
            </section>
          )}

          {draft.provider === "apollo" && (
            <section className="conn-form-section">
              <div className="conn-section-title">{t("connection.sectionAuth")}</div>
              {secretSourceNote(storedConnectionSecretLabels(["apolloToken"]))}
              <label className="field">
                <FieldLabel {...fieldLabelProps} required tip={t("connection.addressHelp")}>
                  {t("connection.address")}
                </FieldLabel>
                <input
                  type="text"
                  className="search-input wide mono"
                  value={draft.baseUrl}
                  placeholder="http://localhost:8070"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => set({ baseUrl: e.target.value })}
                />
              </label>
              <PasswordField
                label={<FieldLabel {...fieldLabelProps} required tip={t("connection.apolloTokenHelp")}>
                  {t("connection.apolloToken")}
                </FieldLabel>}
                value={draft.apolloToken ?? ""}
                name="connection-apollo-token"
                autoComplete="off"
                className="search-input wide mono"
                onChange={(v) => set({ apolloToken: v })}
              />
              <div className="field-row">
                <label className="field">
                  <FieldLabel {...fieldLabelProps} required tip={t("connection.apolloEnvHelp")}>
                    {t("connection.apolloEnv")}
                  </FieldLabel>
                  <input
                    type="text"
                    className="search-input mono"
                    value={draft.apolloEnv ?? ""}
                    placeholder="DEV"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => set({ apolloEnv: e.target.value })}
                  />
                </label>
                <label className="field">
                  <FieldLabel {...fieldLabelProps} required tip={t("connection.apolloClusterHelp")}>
                    {t("connection.apolloCluster")}
                  </FieldLabel>
                  <input
                    type="text"
                    className="search-input mono"
                    value={draft.apolloCluster ?? ""}
                    placeholder="default"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => set({ apolloCluster: e.target.value })}
                  />
                </label>
              </div>
              <label className="field">
                <FieldLabel {...fieldLabelProps} required tip={t("connection.apolloAppIdHelp")}>
                  {t("connection.apolloAppId")}
                </FieldLabel>
                <input
                  type="text"
                  className="search-input wide mono"
                  value={draft.apolloAppId ?? ""}
                  placeholder="order-service"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => set({ apolloAppId: e.target.value, defaultNamespace: e.target.value })}
                />
              </label>
              <label className="field">
                <FieldLabel {...fieldLabelProps} required tip={t("connection.apolloNamespaceNameHelp")}>
                  {t("connection.apolloNamespaceName")}
                </FieldLabel>
                <input
                  type="text"
                  className="search-input wide mono"
                  value={draft.apolloNamespaceName ?? ""}
                  placeholder="application"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => set({ apolloNamespaceName: e.target.value })}
                />
              </label>
            </section>
          )}

          {draft.provider === "consul" && (
            <section className="conn-form-section">
              <div className="conn-section-title">{t("connection.sectionAuth")}</div>
              {secretSourceNote(storedConnectionSecretLabels(["consulToken"]))}
              <label className="field">
                <FieldLabel {...fieldLabelProps} required tip={t("connection.addressHelp")}>
                  {t("connection.address")}
                </FieldLabel>
                <input
                  type="text"
                  className="search-input wide mono"
                  value={draft.baseUrl}
                  placeholder="http://localhost:8500"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => set({ baseUrl: e.target.value })}
                />
              </label>
              <PasswordField
                label={<FieldLabel {...fieldLabelProps} tip={t("connection.consulTokenHelp")}>
                  {t("connection.consulToken")}
                </FieldLabel>}
                value={draft.consulToken ?? ""}
                name="connection-consul-token"
                autoComplete="off"
                className="search-input wide mono"
                onChange={(v) => set({ consulToken: v })}
              />
              <div className="field-row">
                <label className="field">
                  <FieldLabel {...fieldLabelProps} tip={t("connection.consulDatacenterHelp")}>
                    {t("connection.consulDatacenter")}
                  </FieldLabel>
                  <input
                    type="text"
                    className="search-input mono"
                    value={draft.consulDatacenter ?? ""}
                    placeholder="dc1"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => set({ consulDatacenter: e.target.value, defaultNamespace: e.target.value })}
                  />
                </label>
                <label className="field">
                  <FieldLabel {...fieldLabelProps} tip={t("connection.consulKeyPrefixHelp")}>
                    {t("connection.consulKeyPrefix")}
                  </FieldLabel>
                  <input
                    type="text"
                    className="search-input mono"
                    value={draft.consulKeyPrefix ?? ""}
                    placeholder="apps/order/"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => set({ consulKeyPrefix: e.target.value })}
                  />
                </label>
              </div>
            </section>
          )}

          <section className="conn-form-section">
            <div className="conn-section-title">{t("connection.sectionSecurity")}</div>
            {draft.provider !== "local" && (
              <label className="check-field">
                <FieldLabel {...fieldLabelProps} tip={t("connection.useProxyHelp")}>
                  {t("connection.useProxy")}
                </FieldLabel>
                <input type="checkbox" checked={!!draft.useProxy} onChange={(e) => set({ useProxy: e.target.checked })} />
              </label>
            )}
            {!draft.useProxy && <div className="field-hint">{t("connection.proxyOffHint")}</div>}
          </section>

          {draft.provider === "nacos" && (
            <section className="conn-form-section">
              <div className="conn-section-title">{t("connection.sectionAdvanced")}</div>
              {secretSourceNote(storedConnectionSecretLabels(["password", "accessKeyId", "accessKeySecret", "securityToken"]))}
              {draft.authType !== "aliyun-aksk" && (
                <div className="field-row">
                  <label className="field">
                    <FieldLabel {...fieldLabelProps} required={draft.authType === "nacos-password"} tip={t("connection.usernameHelp")}>
                      {t("connection.username")}
                    </FieldLabel>
                    <input
                      type="text"
                      className="search-input mono"
                      value={draft.username}
                      placeholder={t("connection.usernamePlaceholder")}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) => set({ username: e.target.value })}
                    />
                  </label>
                  <PasswordField
                    label={<FieldLabel {...fieldLabelProps} required={draft.authType === "nacos-password"} tip={t("connection.passwordHelp")}>
                      {t("connection.password")}
                    </FieldLabel>}
                    value={draft.password}
                    name="connection-nacos-password"
                    autoComplete="current-password"
                    className="search-input wide mono"
                    onChange={(v) => set({ password: v })}
                  />
                </div>
              )}
              {draft.authType === "aliyun-aksk" && (
                <>
                  <div className="field-row">
                    <label className="field">
                      <FieldLabel {...fieldLabelProps} required tip={t("connection.accessKeyHelp")}>
                        {t("connection.accessKeyId")}
                      </FieldLabel>
                      <input
                        type="text"
                        className="search-input mono"
                        value={draft.accessKeyId ?? ""}
                        placeholder={t("connection.accessKeyIdPlaceholder")}
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        onChange={(e) => set({ accessKeyId: e.target.value })}
                      />
                    </label>
                    <PasswordField
                      label={<FieldLabel {...fieldLabelProps} required tip={t("connection.accessKeyHelp")}>
                        {t("connection.accessKeySecret")}
                      </FieldLabel>}
                      value={draft.accessKeySecret ?? ""}
                      name="connection-access-key-secret"
                      autoComplete="off"
                      className="search-input wide mono"
                      onChange={(v) => set({ accessKeySecret: v })}
                    />
                  </div>
                  <label className="field">
                    <FieldLabel {...fieldLabelProps} tip={t("connection.securityTokenHelp")}>
                      {t("connection.securityToken")}
                    </FieldLabel>
                    <input
                      type="text"
                      className="search-input wide mono"
                      value={draft.securityToken ?? ""}
                      placeholder={t("connection.securityTokenPlaceholder")}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) => set({ securityToken: e.target.value })}
                    />
                  </label>
                </>
              )}
              <label className="field">
                <FieldLabel id={namespaceCaptionId} {...fieldLabelProps} tip={t("connection.defaultNamespaceHelp")}>
                  {t("connection.defaultNamespace")}
                </FieldLabel>
                <div className="namespace-field">
                  <input
                    type="text"
                    className="search-input wide mono"
                    aria-labelledby={namespaceCaptionId}
                    value={draft.defaultNamespace}
                    placeholder={t("connection.defaultNamespacePlaceholder")}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => set({ defaultNamespace: e.target.value })}
                  />
                  <button type="button" className="btn btn-ghost btn-sm" onClick={loadDefaultNamespaceOptions} disabled={loadingNamespaces}>
                    {loadingNamespaces ? t("connection.loadingNamespaces") : t("connection.loadNamespaces")}
                  </button>
                </div>
                {(visibleNamespaces.length > 0 || visibleNamespaceError) && (
                  <div className="namespace-select-wrap">
                    {visibleNamespaces.length > 0 && (
                      <select
                        className="search-input wide"
                        aria-labelledby={namespaceCaptionId}
                        value={draft.defaultNamespace}
                        onChange={(e) => set({ defaultNamespace: e.target.value })}
                      >
                        <option value="">{t("app.namespaceDefault")}</option>
                        {visibleNamespaces
                          .filter((item) => item.namespace)
                          .map((item) => (
                            <option value={item.namespace} key={item.namespace}>
                              {item.namespaceShowName || item.namespace} / {item.namespace} ({item.configCount})
                            </option>
                          ))}
                      </select>
                    )}
                    {visibleNamespaceError && (
                      <div className="field-error-box" {...statusMessageProps("error")}>
                        <span className="field-error">
                          {t("connection.loadNamespacesFailed")}: {visibleNamespaceError}
                        </span>
                        <div className="field-error-actions">
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={loadDefaultNamespaceOptions}
                            disabled={loadingNamespaces}
                          >
                            {t("common.retry")}
                          </button>
                          <CopyButton
                            text={`${t("connection.loadNamespacesFailed")}: ${visibleNamespaceError}`}
                            label={t("common.copyError")}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </label>
              {draft.provider === "nacos" && (
                <label className="field">
                  <FieldLabel {...fieldLabelProps} tip={t("connection.defaultGroupHelp")}>
                    {t("connection.defaultGroup")}
                  </FieldLabel>
                  <input
                    type="text"
                    className="search-input wide mono"
                    value={draft.defaultGroup ?? ""}
                    placeholder={t("connection.defaultGroupPlaceholder")}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => set({ defaultGroup: e.target.value })}
                  />
                </label>
              )}
            </section>
          )}

          {/* SSH 隧道配置 */}
          {draft.provider === "nacos" && accessMode === "ssh" && (
            <section className="conn-form-section">
              <div className="conn-section-title">SSH</div>
              <button type="button" className="ssh-toggle" onClick={() => setShowSSHConfig(!showSSHConfig)} aria-expanded={showSSHConfig}>
                {showSSHConfig ? "▼" : "▶"} {t("connection.sshConfig")}
                {(draft.sshConfig?.host || selectedSSHProfile) && <span className="ssh-badge">{t("connection.sshConfigured")}</span>}
              </button>

              {showSSHConfig && (
                <div className="ssh-config">
                  <label className="field">
                    <FieldLabel {...fieldLabelProps} tip={t("connection.sshProfileHelp")}>
                      {t("connection.sshProfile")}
                    </FieldLabel>
                    <select className="search-input wide" value={draft.sshProfileId ?? ""} onChange={(e) => setSSHProfile(e.target.value)}>
                      <option value="">{t("connection.sshProfileInline")}</option>
                      {sshProfiles.map((profile) => (
                        <option value={profile.id} key={profile.id}>
                          {sshProfileLabel(profile)}
                        </option>
                      ))}
                    </select>
                  </label>

                  {selectedSSHProfile && (
                    <div className="ssh-profile-summary">
                      <div className="ssh-profile-title">{sshProfileLabel(selectedSSHProfile)}</div>
                      <div className="ssh-profile-meta">
                        {selectedSSHProfile.config.authType === "key" ? t("connection.keyAuth") : t("connection.passwordAuth")}
                        {selectedSSHProfile.config.localPort ? ` / localhost:${selectedSSHProfile.config.localPort}` : ""}
                      </div>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copySSHProfileToInline()}>
                        {t("connection.sshProfileCopyInline")}
                      </button>
                    </div>
                  )}

                  {!selectedSSHProfile && (
                    <>
                      {secretSourceNote(storedSSHSecretLabels(SSH_SECRET_FIELDS))}
                      <label className="field">
                        <FieldLabel {...fieldLabelProps} required tip={t("connection.sshHostHelp")}>
                          {t("connection.sshHost")}
                        </FieldLabel>
                        <input
                          type="text"
                          className="search-input wide"
                          value={draft.sshConfig?.host || ""}
                          placeholder={t("connection.sshHostPlaceholder")}
                          onChange={(e) => setSSH({ host: e.target.value })}
                        />
                      </label>

                      <div className="field-row">
                        <label className="field">
                          <FieldLabel {...fieldLabelProps} required tip={t("connection.sshPortHelp")}>
                            {t("connection.sshPort")}
                          </FieldLabel>
                          <NumberField
                            value={draft.sshConfig?.port}
                            min={PORT_MIN}
                            max={PORT_MAX}
                            fallback={SSH_DEFAULT_PORT}
                            validate={(next) => portIssue(next, { label: t("connection.sshPort") })}
                            onChange={(port) => setSSH({ port })}
                          />
                        </label>
                        <label className="field">
                          <FieldLabel {...fieldLabelProps} required tip={t("connection.sshUsernameHelp")}>
                            {t("connection.sshUsername")}
                          </FieldLabel>
                          <input
                            type="text"
                            className="search-input mono"
                            spellCheck={false}
                            value={draft.sshConfig?.username || ""}
                            placeholder="root"
                            onChange={(e) => setSSH({ username: e.target.value })}
                          />
                        </label>
                      </div>

                      <label className="field">
                        <FieldLabel {...fieldLabelProps} required tip={t("connection.sshAuthHelp")}>
                          {t("connection.authType")}
                        </FieldLabel>
                        <select
                          className="search-input wide"
                          value={draft.sshConfig?.authType || "password"}
                          onChange={(e) => setSSH({ authType: e.target.value as "password" | "key" })}
                        >
                          <option value="password">{t("connection.passwordAuth")}</option>
                          <option value="key">{t("connection.keyAuth")}</option>
                        </select>
                      </label>

                      {(draft.sshConfig?.authType ?? "password") === "password" && (
                        <PasswordField
                          label={<FieldLabel {...fieldLabelProps} required tip={t("connection.sshPasswordHelp")}>
                            {t("connection.sshPassword")}
                          </FieldLabel>}
                          value={draft.sshConfig?.password || ""}
                          name="connection-ssh-password"
                          autoComplete="current-password"
                          className="search-input wide mono"
                          onChange={(v) => setSSH({ password: v })}
                        />
                      )}

                      {draft.sshConfig?.authType === "key" && (
                        <>
                          <label className="field">
                            <FieldLabel {...fieldLabelProps} required tip={t("connection.privateKeyHelp")}>
                              {t("connection.privateKey")}
                            </FieldLabel>
                            <textarea
                              className="search-input wide mono ssh-key"
                              spellCheck={false}
                              value={draft.sshConfig?.privateKey || ""}
                              placeholder="-----BEGIN RSA PRIVATE KEY-----"
                              onChange={(e) => setSSH({ privateKey: e.target.value })}
                            />
                          </label>
                          <PasswordField
                            label={<FieldLabel {...fieldLabelProps} tip={t("connection.privateKeyPasswordHelp")}>
                              {t("connection.privateKeyPassword")}
                            </FieldLabel>}
                            value={draft.sshConfig?.passphrase || ""}
                            name="connection-ssh-passphrase"
                            autoComplete="off"
                            className="search-input wide mono"
                            onChange={(v) => setSSH({ passphrase: v })}
                          />
                        </>
                      )}

                      <label className="field">
                        <FieldLabel {...fieldLabelProps} tip={t("connection.localPortHelp")}>
                          {t("connection.localPort")}
                        </FieldLabel>
                        <NumberField
                          value={draft.sshConfig?.localPort}
                          min={PORT_MIN}
                          max={PORT_MAX}
                          placeholder={t("connection.localPortPlaceholder")}
                          validate={(next) => portIssue(next, { label: t("connection.localPortShort"), optional: true })}
                          onChange={(localPort) => setSSH({ localPort })}
                        />
                      </label>

                      <span className="btn-guard" title={portBlock}>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={saveInlineSSHAsProfile}
                          disabled={!!portBlock}
                          aria-disabled={!!portBlock}
                        >
                          {t("connection.sshProfileSave")}
                        </button>
                      </span>

                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setDraft((d) => ({ ...d, sshConfig: undefined, sshProfileId: "" }));
                          setShowSSHConfig(false);
                        }}
                      >
                        {t("connection.removeSSH")}
                      </button>
                    </>
                  )}
                </div>
              )}
            </section>
          )}

          {visibleTestTrace ? (
            <TestTraceView trace={visibleTestTrace} />
          ) : (
            visibleTestMsg && (
              <div
                className={`test-msg ${visibleTestMsg.ok ? "ok" : "err"}`}
                {...statusMessageProps(visibleTestMsg.ok ? "success" : "error")}
              >
                <span className="test-msg-text" title={visibleTestMsg.text}>
                  {displayTestMessage(visibleTestMsg.text)}
                </span>
                {!visibleTestMsg.ok && <CopyButton text={visibleTestMsg.text} label={t("common.copyError")} />}
              </div>
            )
          )}

          <div className="conn-form-actions">
            <TestButton onClick={doTest} running={testingCurrent} />
            <div className="spacer" />
            {draft.id && (
              <button className="btn btn-ghost" onClick={() => startNew()}>
                {t("connection.new")}
              </button>
            )}
            <span className="btn-guard" title={portBlock}>
              <button className="btn btn-primary" onClick={() => void save()} disabled={!!portBlock} aria-disabled={!!portBlock}>
                {t("common.save")}
              </button>
            </span>
          </div>
        </div>
      </div>
    </>
  );

  if (embedded) {
    return <div className="page-surface connection-page">{content}</div>;
  }

  return (
    <div className="modal-overlay" {...overlayDismiss}>
      <div ref={modalRef} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        {content}
      </div>
    </div>
  );
}
