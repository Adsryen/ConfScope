import { useEffect, useRef, useState, type ReactNode } from "react";
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
import {
  loadSSHProfiles,
  normalizeSSHConfig,
  sshProfileLabel,
  upsertSSHProfile,
  type SSHProfile,
} from "../store/sshProfiles";
import { clearToken, listNamespaces, testConnection, type Namespace } from "../api/nacos";
import {
  selectLocalSnapshotDirectory,
  validateLocalSnapshotDirectory,
  type LocalSnapshotValidation,
} from "../api/app";
import { useTranslation } from "../i18n";
import CopyButton from "./CopyButton";
import TestTraceView, { TestTrace, TraceStep } from "./TestTraceView";

interface Props {
  onClose: () => void;
  onChange: (conns: Connection[]) => void;
  embedded?: boolean;
}

type Draft = Omit<Connection, "id"> & { id?: string };

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
  sshConfig: undefined,
  sshProfileId: "",
});

type HelpPopover = { text: string; top: number; left: number };

function latencyText(startedAt: number): string {
  return `延迟 ${Math.max(0, Date.now() - startedAt)} ms`;
}

function displayTestMessage(text: string): string {
  const value = text.trim();
  if (value.length <= 360) return value;
  return `${value.slice(0, 360)}...`;
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

function traceProviderName(snapshot: Draft): string {
  return snapshot.distribution === "aliyun-mse" ? "阿里云 MSE Nacos" : "Nacos";
}

function sshTraceDetail(snapshot: Draft): string {
  const sshConfig = traceSshConfig(snapshot);
  if (snapshot.sshProfileId) return "已选择 SSH 档案，后续步骤会验证本地隧道入口和远端目标。";
  if (!sshConfig?.host) return "未配置 SSH 隧道。";
  return `${sshConfig.host}:${sshConfig.port} / ${sshConfig.username}`;
}

function looksLikeTunnelForwardError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    (text.includes("localhost") || text.includes("127.0.0.1")) &&
    (
      text.includes("wsarecv") ||
      text.includes("forcibly closed") ||
      text.includes("connection reset") ||
      text.includes("connection refused") ||
      text.includes("broken pipe") ||
      text.includes("eof")
    )
  );
}

function looksLikeConfigCenterResponse(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("nacos 返回") ||
    text.includes("http status") ||
    text.includes("\"status\":") ||
    text.includes("check signature") ||
    text.includes("invalid access key") ||
    text.includes("invalid signature") ||
    text.includes("forbidden") ||
    text.includes("unauthorized")
  );
}

function buildConnectionTrace(snapshot: Draft, startedAt: number, ok: boolean, detail: string): TestTrace {
  const hasSSH = traceHasSSH(snapshot);
  const tunnelForwardError = hasSSH && !ok && looksLikeTunnelForwardError(detail);
  const configCenterResponse = ok || looksLikeConfigCenterResponse(detail);
  const sshSetupError = hasSSH && !ok && !tunnelForwardError && !configCenterResponse;
  const interfaceName = snapshot.distribution === "aliyun-mse" ? "MSE/Nacos 接口" : "Nacos 接口";
  const steps: TraceStep[] = [
    {
      name: "连接参数检查",
      status: "checked",
      detail: `目标配置：${traceProviderName(snapshot)} / ${snapshot.baseUrl}。这里只表示本地连接参数已读取，不代表已经连通配置中心。`,
    },
  ];
  if (hasSSH) {
    steps.push({
      name: "SSH 配置",
      status: "ok",
      detail: sshTraceDetail(snapshot),
    });
    steps.push({
      name: "本地隧道入口",
      status: sshSetupError ? "error" : "ok",
      detail: tunnelForwardError
        ? "请求已经进入本地隧道入口，但后续远端转发失败。"
        : configCenterResponse
          ? "请求已通过本地隧道入口继续转发。"
          : "未确认本地隧道入口可用，请检查 SSH 登录、私钥、端口占用和本地转发创建情况。",
    });
    steps.push({
      name: "远端目标连通性",
      status: tunnelForwardError ? "error" : sshSetupError ? "skipped" : "ok",
      detail: tunnelForwardError
        ? `本地端口已接收请求，但转发到远端目标时连接被关闭或重置。请检查 SSH 档案指向的跳板机、Nacos 内网地址、目标端口和防火墙策略。\n原始错误：${detail}`
        : sshSetupError
          ? "本地隧道入口未确认可用，尚不能判断远端目标是否连通。"
          : ok
          ? "远端目标已连通。"
          : "已收到配置中心响应，远端目标连通性已确认。",
    });
  }
  steps.push({
    name: interfaceName,
    status: tunnelForwardError || sshSetupError ? "skipped" : ok ? "ok" : "error",
    detail: tunnelForwardError
      ? "远端目标未连通，尚不能判断配置中心接口本身是否正常。"
      : sshSetupError
        ? "SSH 会话或本地隧道入口未建立，尚不能判断配置中心接口本身是否正常。"
      : detail,
    latencyMs: elapsedMs(startedAt),
  });
  return {
    ok,
    title: ok ? "连接测试成功" : "连接测试失败",
    summary: ok
      ? hasSSH ? "SSH 入口、远端目标与配置中心接口均通过。" : "配置中心接口通过。"
      : tunnelForwardError
        ? "请求进入本地隧道入口，但远端目标未连通，请优先排查 SSH 档案、目标内网地址、目标端口和防火墙。"
        : sshSetupError
          ? "SSH 会话或本地隧道入口未建立，请优先排查 SSH 登录、私钥、端口占用和本地转发创建情况。"
        : hasSSH ? "已到达配置中心链路，接口返回失败，请按接口错误排查鉴权、路径、命名空间或 MSE 签名配置。" : "配置中心接口测试失败。",
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
    defaultNamespace: draft.defaultNamespace ?? "",
    sshProfileId: draft.sshProfileId ?? "",
    sshConfig: sshConfig.host ? sshConfig : undefined,
    forceLocalSnapshot: !!draft.forceLocalSnapshot,
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

function getHelpPopover(text: string, target: HTMLElement): HelpPopover {
  const rect = target.getBoundingClientRect();
  const width = Math.min(320, Math.max(220, window.innerWidth - 24));
  const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, 12), window.innerWidth - width - 12);
  const estimatedHeight = 92;
  const top =
    rect.top > estimatedHeight + 18
      ? rect.top - estimatedHeight - 8
      : Math.min(rect.bottom + 8, window.innerHeight - estimatedHeight - 12);
  return { text, top, left };
}

function HelpTip({ text, onShow, onHide }: {
  text: string;
  onShow: (popover: HelpPopover) => void;
  onHide: () => void;
}) {
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
  onHelpShow,
  onHelpHide,
}: {
  children: ReactNode;
  tip?: string;
  required?: boolean;
  onHelpShow: (popover: HelpPopover) => void;
  onHelpHide: () => void;
}) {
  return (
    <span className="field-label">
      <span>{children}</span>
      {required && <span className="required-mark" aria-hidden="true">*</span>}
      {tip && <HelpTip text={tip} onShow={onHelpShow} onHide={onHelpHide} />}
    </span>
  );
}

export default function ConnectionManager({ onClose, onChange, embedded = false }: Props) {
  const { t } = useTranslation();
  const defaultNewEnvironment = t('connection.environmentDev');
  const [list, setList] = useState<Connection[]>(loadConnections());
  const [sshProfiles, setSSHProfiles] = useState<SSHProfile[]>(loadSSHProfiles());
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
  const [activeEnvironment, setActiveEnvironment] = useState(
    emptyDraft(defaultNewEnvironment).environmentName ?? defaultNewEnvironment
  );
  const [creatingProject, setCreatingProject] = useState(false);
  const [renamingProject, setRenamingProject] = useState<{ oldName: string; value: string } | null>(null);
  // 待确认删除的连接 id（点一次 × 进入确认态，再点才删）
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [showPwd, setShowPwd] = useState(false);
  const [showSSHConfig, setShowSSHConfig] = useState(false);
  const [showSSHPwd, setShowSSHPwd] = useState(false);
  const [showSSHPassphrase, setShowSSHPassphrase] = useState(false);
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

  // Esc 关闭弹框
  useEffect(() => {
    if (embedded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [embedded, onClose]);

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
        port: 22,
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
          port: 22,
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

  const copySSHProfileToInline = () => {
    if (!selectedSSHProfile) return;
    setDraft((d) => ({
      ...d,
      sshProfileId: "",
      sshConfig: { ...selectedSSHProfile.config },
    }));
    setShowSSHConfig(true);
  };

  const saveInlineSSHAsProfile = () => {
    const config = normalizeSSHConfig(draft.sshConfig);
    if (!config.host.trim() || !config.username.trim()) {
      setTestMsg({ ok: false, text: t('connection.sshProfileRequired') });
      return;
    }
    const profile = upsertSSHProfile({
      name: draft.name?.trim() || draft.sourceName?.trim() || `${config.username}@${config.host}`,
      config,
    });
    setSSHProfiles(loadSSHProfiles());
    setDraft((d) => ({ ...d, sshProfileId: profile.id, sshConfig: undefined }));
    setShowSSHConfig(true);
    setTestMsg({ ok: true, text: t('connection.sshProfileSaved') });
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
      sshConfig: d.sshProfileId ? undefined : d.sshConfig ?? {
        host: "",
        port: 22,
        username: "root",
        authType: "password",
      },
    }));
    setShowSSHConfig(true);
  };

  const groupedConnections = list.reduce<
    { project: string; environments: { environment: string; connections: Connection[] }[] }[]
  >((projects, conn) => {
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
  }, []);
  const projectOptions = groupedConnections.map((project) => project.project);
  const environmentPresets = [
    t('connection.environmentDev'),
    t('connection.environmentTest'),
    t('connection.environmentStaging'),
    t('connection.environmentProd'),
    t('connection.environmentCanary'),
    t('connection.environmentLocal'),
  ];
  const currentEnvironment = draft.environmentName?.trim();
  const environmentOptions = Array.from(
    new Set(currentEnvironment && !environmentPresets.includes(currentEnvironment)
      ? [currentEnvironment, ...environmentPresets]
      : environmentPresets)
  );
  const accessMode = showSSHConfig || draft.sshConfig || draft.sshProfileId ? "ssh" : "direct";
  const nacosSourceNamePresets = [
    { label: t('connection.sourcePresetPublic'), mode: "direct" as const },
    { label: t('connection.sourcePresetCloudIntranet'), mode: "direct" as const },
    { label: t('connection.sourcePresetCompanyIntranet'), mode: "direct" as const },
    { label: t('connection.sourcePresetOffice'), mode: "direct" as const },
  ];
  const localSnapshotSourceNamePreset = { label: t('connection.sourcePresetLocalSnapshot'), mode: "direct" as const };
  const sourceNamePresets = draft.sourceType === "local-snapshot"
    ? [localSnapshotSourceNamePreset]
    : nacosSourceNamePresets;
  const selectedSourcePreset = sourceNamePresets.some((item) => item.label === draft.sourceName)
    ? draft.sourceName ?? ""
    : "";
  const currentProjectName = (draft.projectName ?? DEFAULT_PROJECT_NAME).trim();
  const selectedProjectOption = !creatingProject && projectOptions.includes(currentProjectName)
    ? currentProjectName
    : "__new__";
  const showProjectInput = creatingProject || projectOptions.length === 0 || selectedProjectOption === "__new__";

  const setSourceType = (sourceType: Draft["sourceType"]) => {
    setDraft((d) => {
      const wasUsingNacosPreset = nacosSourceNamePresets.some((item) => item.label === d.sourceName);
      const wasUsingLocalSnapshotPreset = d.sourceName === localSnapshotSourceNamePreset.label;
      const shouldDefaultLocalName = sourceType === "local-snapshot" && (!d.sourceName?.trim() || wasUsingNacosPreset);
      const shouldClearLocalName = sourceType !== "local-snapshot" && wasUsingLocalSnapshotPreset;

      return {
        ...d,
        sourceType,
        sourceName: shouldDefaultLocalName
          ? localSnapshotSourceNamePreset.label
          : shouldClearLocalName
            ? ""
            : d.sourceName,
      };
    });
    setLocalValidation(null);
  };

  const refresh = () => {
    const next = loadConnections();
    setList(next);
    onChange(next);
  };

  const startNew = (projectName = activeProject, environmentName = activeEnvironment) => {
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

  const edit = (c: Connection) => {
    setActiveProject(connectionProjectName(c));
    setActiveEnvironment(connectionEnvironmentName(c));
    setDraft({ ...c });
    setCreatingProject(!projectOptions.includes(connectionProjectName(c)));
    setTestMsg(null);
    setNamespaceResultKey(null);
    setNamespaceOptions([]);
    setNamespaceError(null);
    setLocalValidation(c.localValidation ? {
      valid: c.localValidation.valid,
      path: c.localPath ?? "",
      message: c.localValidation.message,
      configCount: c.localValidation.configCount,
      hasManifest: false,
      matchedMarkers: [],
      checkedAt: c.localValidation.checkedAt,
    } : null);
    setConfirmDel(null);
    setShowSSHConfig(!!c.sshConfig?.host || !!c.sshProfileId);
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
      projectName:
        (d.projectName ?? DEFAULT_PROJECT_NAME) === renamingProject.oldName ? nextName : d.projectName,
    }));
    setRenamingProject(null);
  };

  const save = () => {
    if (!draft.sourceName?.trim() || (draft.sourceType !== "local-snapshot" && !draft.baseUrl.trim())) {
      setTestMsg({ ok: false, text: t('connection.nameAndAddressRequired') });
      return;
    }
    if (draft.sourceType === "local-snapshot") {
      if (!draft.localPath?.trim()) {
        setTestMsg({ ok: false, text: t('connection.localPathRequired') });
        return;
      }
      if (!draft.forceLocalSnapshot && (!localValidation?.valid || localValidation.path !== draft.localPath.trim())) {
        setTestMsg({ ok: false, text: t('connection.localValidationRequired') });
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
    const sourceName = toSave.sourceName?.trim() || toSave.name.trim();
    const connectionName = toSave.name.trim() || sourceName;
    const saved = upsertConnection({
      ...toSave,
      name: connectionName,
      projectName: toSave.projectName?.trim() || DEFAULT_PROJECT_NAME,
      environmentName: toSave.environmentName?.trim() || DEFAULT_ENVIRONMENT_NAME,
      sourceName,
      sourceType: toSave.sourceType ?? "nacos",
      localPath: toSave.localPath?.trim() || "",
      forceLocalSnapshot: !!toSave.forceLocalSnapshot,
      localValidation: localValidation ? {
        valid: localValidation.valid,
        message: localValidation.message,
        configCount: localValidation.configCount,
        checkedAt: localValidation.checkedAt,
      } : undefined,
      baseUrl: toSave.sourceType === "local-snapshot" ? toSave.localPath?.trim() || "" : toSave.baseUrl.trim(),
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
    const startedAt = Date.now();
    const snapshot: Draft = {
      ...draft,
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
      if (snapshot.authType === "aliyun-aksk" || snapshot.username) {
        const r = await testConnection({ ...(snapshot as Connection), id: snapshot.id ?? "test" });
        if (currentTestKeyRef.current !== snapshotKey) return;
        const latency = latencyText(startedAt);
        setTestMsg({
          ok: true,
          text: r.globalAdmin ? `连接成功（管理员账号，${latency}）` : `连接成功（${latency}）`,
        });
        setTestTrace(buildConnectionTrace(snapshot, startedAt, true, r.globalAdmin ? "连接成功，当前账号为管理员账号。" : "连接成功。"));
      } else {
        // 无账号：尝试无鉴权访问命名空间接口验证可达性
        if (currentTestKeyRef.current !== snapshotKey) return;
        setTestMsg({ ok: true, text: `未配置账号，将以免鉴权方式连接（${latencyText(startedAt)}）` });
        setTestTrace(buildConnectionTrace(snapshot, startedAt, true, "未配置账号，将以免鉴权方式连接。"));
      }
    } catch (e) {
      if (currentTestKeyRef.current !== snapshotKey) return;
      const message = String(e);
      setTestMsg({ ok: false, text: `${message}（${latencyText(startedAt)}）` });
      setTestTrace(buildConnectionTrace(snapshot, startedAt, false, message));
    } finally {
      setTestingKey((current) => (current === snapshotKey ? null : current));
    }
  };

  const loadDefaultNamespaceOptions = async () => {
    if (draft.sourceType === "local-snapshot") return;
    if (!draft.baseUrl.trim()) {
      setNamespaceResultKey(currentNamespaceKey);
      setNamespaceOptions([]);
      setNamespaceError(t('connection.addressRequired'));
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
      setNamespaceError(String(e));
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
      setTestMsg({ ok: false, text: t('connection.localPathRequired') });
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
        text: (result.valid
          ? t('connection.localValidationOk').replace("{count}", String(result.configCount))
          : result.message) + (showLatency ? `（${latencyText(startedAt)}）` : ""),
      });
      return result;
    } catch (e) {
      if (currentTestKeyRef.current !== resultKey) return null;
      setTestMsg({ ok: false, text: String(e) });
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
      setTestMsg({ ok: false, text: String(e) });
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
          <h3>{t('connection.title')}</h3>
          {embedded && <div className="page-subtitle">{t('connection.pageSubtitle')}</div>}
        </div>
        {!embedded && (
          <button className="modal-x" onClick={onClose} title={t('common.close')}>
            ×
          </button>
        )}
      </div>

      <div className={embedded ? "conn-mgr conn-mgr-page" : "modal-body conn-mgr"}>
          <div className="conn-list">
            <div className="conn-list-title">{t('connection.savedConnections')}</div>
            <button className="btn btn-primary btn-sm conn-create-btn" onClick={() => startNew()}>
              {t('connection.addSource')}
            </button>
            {list.length === 0 && <div className="conn-empty">{t('connection.noConnections')}</div>}
            {groupedConnections.map((project) => (
              <div className="conn-group" key={project.project}>
                <div
                  className={`conn-group-title${activeProject === project.project ? " active" : ""}`}
                  onClick={() => selectContext(project.project)}
                >
                  {renamingProject?.oldName === project.project ? (
                    <input
                      className="conn-inline-input"
                      value={renamingProject.value}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenamingProject({ ...renamingProject, value: e.target.value })}
                      onBlur={commitProjectRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitProjectRename();
                        if (e.key === "Escape") setRenamingProject(null);
                      }}
                    />
                  ) : (
                    <span className="conn-group-name">{project.project}</span>
                  )}
                  <div className="conn-tree-actions">
                    <button
                      className="conn-tree-btn"
                      title={t('connection.addSource')}
                      onClick={(e) => {
                        e.stopPropagation();
                        startNew(project.project, project.environments[0]?.environment ?? DEFAULT_ENVIRONMENT_NAME);
                      }}
                    >
                      +
                    </button>
                    <button
                      className="conn-tree-btn"
                      title={t('connection.renameProject')}
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
                    >
                      <span className="conn-env-name">{env.environment}</span>
                      <div className="conn-tree-actions">
                        <button
                          className="conn-tree-btn"
                          title={t('connection.addSource')}
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
                      >
                        <div className="conn-item-main">
                          <div className="conn-item-name">
                            {connectionSourceName(c)}
                            {c.isDefaultSource && <span className="conn-ssh-badge">{t('connection.defaultSource')}</span>}
                            {(c.sshConfig || c.sshProfileId) && <span className="conn-ssh-badge" title="SSH 隧道">🔒SSH</span>}
                          </div>
                          <div className="conn-item-url">
                            <span>{c.sourceType === "local-snapshot" ? t('connection.sourceTypeSnapshot') : t('connection.sourceTypeNacos')}</span>
                            <span>{sourceAddress(c)}</span>
                            {connectionLabelMeta(c) && <span>{t('connection.connectionLabelShort')}: {connectionLabelMeta(c)}</span>}
                          </div>
                        </div>
                        {confirmDel === c.id ? (
                          <button
                            className="conn-item-del confirm"
                            title={t('connection.confirmDelete')}
                            onClick={(e) => {
                              e.stopPropagation();
                              askOrRemove(c.id);
                            }}
                          >
                            {t('connection.deleteConfirm')}
                          </button>
                        ) : (
                          <button
                            className="conn-item-del"
                            title={t('common.delete')}
                            onClick={(e) => {
                              e.stopPropagation();
                              askOrRemove(c.id);
                            }}
                          >
                            ×
                          </button>
                        )}
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
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              }
            }}
          >
            <div className="conn-form-title">{draft.id ? t('connection.edit') : t('connection.new')}</div>
            {helpPopover && (
              <div
                className="help-popover"
                style={{ top: helpPopover.top, left: helpPopover.left }}
              >
                {helpPopover.text}
              </div>
            )}

            <section className="conn-form-section">
              <div className="conn-section-title">{t('connection.sectionOwnership')}</div>
              <div className="field-row">
                <label className="field">
                  <FieldLabel {...fieldLabelProps} required tip={t('connection.projectHelp')}>{t('connection.project')}</FieldLabel>
                  {projectOptions.length > 0 && (
                    <select
                      className="search-input wide"
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
                      <option value="__new__">{t('connection.projectNewOption')}</option>
                    </select>
                  )}
                  {showProjectInput && (
                    <input
                      className="search-input wide"
                      value={draft.projectName ?? ""}
                      placeholder={t('connection.projectPlaceholder')}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) => set({ projectName: e.target.value })}
                    />
                  )}
                </label>
                <label className="field">
                  <FieldLabel {...fieldLabelProps} required tip={t('connection.environmentHelp')}>{t('connection.environment')}</FieldLabel>
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
            </section>

            <section className="conn-form-section">
              <div className="conn-section-title">{t('connection.sectionSource')}</div>
              <div className="field-row">
                <label className="field">
                  <FieldLabel {...fieldLabelProps} required tip={t('connection.sourceNameHelp')}>{t('connection.sourceName')}</FieldLabel>
                  <input
                    className="search-input wide"
                    value={draft.sourceName ?? ""}
                    placeholder={t('connection.sourceNamePlaceholder')}
                    autoFocus
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => set({ sourceName: e.target.value })}
                  />
                </label>
                <label className="field check-field">
                  <FieldLabel {...fieldLabelProps} tip={t('connection.defaultSourceHelp')}>{t('connection.defaultSource')}</FieldLabel>
                  <input
                    type="checkbox"
                    checked={!!draft.isDefaultSource}
                    onChange={(e) => set({ isDefaultSource: e.target.checked })}
                  />
                </label>
              </div>
              <div className="field-row">
                <label className="field">
                  <FieldLabel {...fieldLabelProps} tip={t('connection.sourcePresetHelp')}>{t('connection.sourcePreset')}</FieldLabel>
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
                    <option value="">{t('connection.sourcePresetCustom')}</option>
                    {sourceNamePresets.map((item) => (
                      <option value={item.label} key={item.label}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <FieldLabel {...fieldLabelProps} required tip={t('connection.sourceTypeHelp')}>{t('connection.sourceType')}</FieldLabel>
                  <select
                    className="search-input wide"
                    value={draft.sourceType ?? "nacos"}
                    onChange={(e) => setSourceType(e.target.value as Draft["sourceType"])}
                  >
                    <option value="nacos">{t('connection.sourceTypeNacos')}</option>
                    <option value="local-snapshot">{t('connection.sourceTypeSnapshot')}</option>
                  </select>
                </label>
              </div>
              {draft.sourceType === "local-snapshot" && (
                <label className="field">
                  <FieldLabel {...fieldLabelProps} required tip={t('connection.localPathHelp')}>{t('connection.localPath')}</FieldLabel>
                  <div className="path-field">
                    <input
                      className="search-input wide mono"
                      value={draft.localPath ?? ""}
                      placeholder={t('connection.localPathPlaceholder')}
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
                      {selectingLocalDir ? t('connection.selectingFolder') : t('connection.selectFolder')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => doValidateLocalSnapshot()}
                      disabled={validatingLocal}
                    >
                      {validatingLocal ? t('connection.validatingLocal') : t('connection.validateLocal')}
                    </button>
                  </div>
                  <div className="field-hint">{t('connection.localPathStructureHint')}</div>
                  <label className="force-local-field">
                    <input
                      type="checkbox"
                      checked={!!draft.forceLocalSnapshot}
                      onChange={(e) => set({ forceLocalSnapshot: e.target.checked })}
                    />
                    <span>{t('connection.forceLocalSnapshot')}</span>
                  </label>
                  {draft.forceLocalSnapshot && (
                    <div className="field-warning">{t('connection.forceLocalSnapshotHelp')}</div>
                  )}
                  {localValidation && (
                    <div className={`local-validation ${localValidation.valid ? "ok" : "err"}`}>
                      {localValidation.valid
                        ? t('connection.localValidationOk').replace("{count}", String(localValidation.configCount))
                        : localValidation.message}
                      <span className="local-validation-path">{localValidation.path}</span>
                    </div>
                  )}
                </label>
              )}
              <label className="field">
                <FieldLabel {...fieldLabelProps} tip={t('connection.nameHelp')}>{t('connection.name')}</FieldLabel>
                <input
                  className="search-input wide"
                  value={draft.name}
                  placeholder={t('connection.namePlaceholder')}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => set({ name: e.target.value })}
                />
              </label>
            </section>
            {draft.sourceType !== "local-snapshot" && <section className="conn-form-section">
              <div className="conn-section-title">{t('connection.sectionConnection')}</div>
              <div className="field-row">
                <label className="field">
                  <FieldLabel {...fieldLabelProps} required tip={t('connection.distributionHelp')}>{t('connection.distribution')}</FieldLabel>
                  <select
                    className="search-input wide"
                    value={draft.distribution ?? "opensource"}
                    onChange={(e) => setDistribution(e.target.value as Draft["distribution"])}
                  >
                    <option value="opensource">{t('connection.opensourceNacos')}</option>
                    <option value="aliyun-mse">{t('connection.aliyunMseNacos')}</option>
                  </select>
                </label>
                <label className="field">
                  <FieldLabel {...fieldLabelProps} required tip={t('connection.accessModeHelp')}>{t('connection.accessMode')}</FieldLabel>
                  <select
                    className="search-input wide"
                    value={accessMode}
                    onChange={(e) => setAccessMode(e.target.value as "direct" | "ssh")}
                  >
                    <option value="direct">{t('connection.accessModeDirect')}</option>
                    <option value="ssh">{t('connection.accessModeSsh')}</option>
                  </select>
                </label>
              </div>
              <label className="field">
                <FieldLabel {...fieldLabelProps} required tip={t('connection.addressHelp')}>{t('connection.address')}</FieldLabel>
                <input
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
                <FieldLabel {...fieldLabelProps} required tip={t('connection.authTypeHelp')}>{t('connection.authType')}</FieldLabel>
                <select
                  className="search-input wide"
                  value={draft.authType ?? "nacos-password"}
                  onChange={(e) => set({ authType: e.target.value as Draft["authType"] })}
                >
                  <option value="none">{t('connection.noAuth')}</option>
                  <option value="nacos-password">{t('connection.nacosPasswordAuth')}</option>
                  <option value="aliyun-aksk">{t('connection.aliyunAKSKAuth')}</option>
                </select>
              </label>
            </section>}

            {draft.sourceType !== "local-snapshot" && <section className="conn-form-section">
              <div className="conn-section-title">{t('connection.sectionCredential')}</div>
              {draft.authType !== "aliyun-aksk" && (
              <div className="field-row">
                <label className="field">
                  <FieldLabel {...fieldLabelProps} required={draft.authType === "nacos-password"} tip={t('connection.usernameHelp')}>{t('connection.username')}</FieldLabel>
                  <input
                    className="search-input mono"
                    value={draft.username}
                    placeholder={t('connection.usernamePlaceholder')}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => set({ username: e.target.value })}
                  />
                </label>
                <label className="field">
                  <FieldLabel {...fieldLabelProps} required={draft.authType === "nacos-password"} tip={t('connection.passwordHelp')}>{t('connection.password')}</FieldLabel>
                  <div className="pwd-field">
                    <input
                      className="search-input wide mono"
                      type={showPwd ? "text" : "password"}
                      value={draft.password}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) => set({ password: e.target.value })}
                    />
                    <button
                      type="button"
                      className="pwd-toggle"
                      title={showPwd ? t('connection.hide') : t('connection.show')}
                      onClick={() => setShowPwd((v) => !v)}
                    >
                      {showPwd ? "🙈" : "👁"}
                    </button>
                  </div>
                </label>
              </div>
              )}
              {draft.authType === "aliyun-aksk" && (
              <>
                <div className="field-row">
                  <label className="field">
                    <FieldLabel {...fieldLabelProps} required tip={t('connection.accessKeyHelp')}>{t('connection.accessKeyId')}</FieldLabel>
                    <input
                      className="search-input mono"
                      value={draft.accessKeyId ?? ""}
                      placeholder={t('connection.accessKeyIdPlaceholder')}
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      onChange={(e) => set({ accessKeyId: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <FieldLabel {...fieldLabelProps} required tip={t('connection.accessKeyHelp')}>{t('connection.accessKeySecret')}</FieldLabel>
                    <div className="pwd-field">
                      <input
                        className="search-input wide mono"
                        type={showPwd ? "text" : "password"}
                        value={draft.accessKeySecret ?? ""}
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        onChange={(e) => set({ accessKeySecret: e.target.value })}
                      />
                      <button
                        type="button"
                        className="pwd-toggle"
                        title={showPwd ? t('connection.hide') : t('connection.show')}
                        onClick={() => setShowPwd((v) => !v)}
                      >
                        {showPwd ? "🙈" : "👁"}
                      </button>
                    </div>
                  </label>
                </div>
                <label className="field">
                  <FieldLabel {...fieldLabelProps} tip={t('connection.securityTokenHelp')}>{t('connection.securityToken')}</FieldLabel>
                  <input
                    className="search-input wide mono"
                    value={draft.securityToken ?? ""}
                    placeholder={t('connection.securityTokenPlaceholder')}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => set({ securityToken: e.target.value })}
                  />
                </label>
              </>
              )}
              <label className="field">
                <FieldLabel {...fieldLabelProps} tip={t('connection.defaultNamespaceHelp')}>{t('connection.defaultNamespace')}</FieldLabel>
                <div className="namespace-field">
                  <input
                    className="search-input wide mono"
                    value={draft.defaultNamespace}
                    placeholder={t('connection.defaultNamespacePlaceholder')}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(e) => set({ defaultNamespace: e.target.value })}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={loadDefaultNamespaceOptions}
                    disabled={loadingNamespaces}
                  >
                    {loadingNamespaces ? t('connection.loadingNamespaces') : t('connection.loadNamespaces')}
                  </button>
                </div>
                {(visibleNamespaces.length > 0 || visibleNamespaceError) && (
                  <div className="namespace-select-wrap">
                    {visibleNamespaces.length > 0 && (
                      <select
                        className="search-input wide"
                        value={draft.defaultNamespace}
                        onChange={(e) => set({ defaultNamespace: e.target.value })}
                      >
                        <option value="">{t('app.namespaceDefault')}</option>
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
                      <div className="field-error">
                        {t('connection.loadNamespacesFailed')}: {visibleNamespaceError}
                      </div>
                    )}
                  </div>
                )}
              </label>
            </section>}

            {/* SSH 隧道配置 */}
            {draft.sourceType !== "local-snapshot" && accessMode === "ssh" && <div className="ssh-section">
              <button
                type="button"
                className="ssh-toggle"
                onClick={() => setShowSSHConfig(!showSSHConfig)}
              >
                {showSSHConfig ? "▼" : "▶"} {t('connection.sshConfig')}
                {(draft.sshConfig?.host || selectedSSHProfile) && <span className="ssh-badge">{t('connection.sshConfigured')}</span>}
              </button>

              {showSSHConfig && (
                <div className="ssh-config">
                  <label className="field">
                    <FieldLabel {...fieldLabelProps} tip={t('connection.sshProfileHelp')}>{t('connection.sshProfile')}</FieldLabel>
                    <select
                      className="search-input wide"
                      value={draft.sshProfileId ?? ""}
                      onChange={(e) => setSSHProfile(e.target.value)}
                    >
                      <option value="">{t('connection.sshProfileInline')}</option>
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
                        {selectedSSHProfile.config.authType === "key" ? t('connection.keyAuth') : t('connection.passwordAuth')}
                        {selectedSSHProfile.config.localPort ? ` / localhost:${selectedSSHProfile.config.localPort}` : ""}
                      </div>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={copySSHProfileToInline}>
                        {t('connection.sshProfileCopyInline')}
                      </button>
                    </div>
                  )}

                  {!selectedSSHProfile && (
                    <>
                  <label className="field">
                    <FieldLabel {...fieldLabelProps} required tip={t('connection.sshHostHelp')}>{t('connection.sshHost')}</FieldLabel>
                    <input
                      className="search-input wide"
                      value={draft.sshConfig?.host || ""}
                      placeholder={t('connection.sshHostPlaceholder')}
                      onChange={(e) => setSSH({ host: e.target.value })}
                    />
                  </label>

                  <div className="field-row">
                    <label className="field">
                      <FieldLabel {...fieldLabelProps} required tip={t('connection.sshPortHelp')}>{t('connection.sshPort')}</FieldLabel>
                      <input
                        className="search-input mono"
                        type="number"
                        value={draft.sshConfig?.port || 22}
                        onChange={(e) => setSSH({ port: parseInt(e.target.value) || 22 })}
                      />
                    </label>
                    <label className="field">
                      <FieldLabel {...fieldLabelProps} required tip={t('connection.sshUsernameHelp')}>{t('connection.sshUsername')}</FieldLabel>
                      <input
                        className="search-input mono"
                        value={draft.sshConfig?.username || ""}
                        placeholder="root"
                        onChange={(e) => setSSH({ username: e.target.value })}
                      />
                    </label>
                  </div>

                  <label className="field">
                    <FieldLabel {...fieldLabelProps} required tip={t('connection.sshAuthHelp')}>{t('connection.authType')}</FieldLabel>
                    <select
                      className="search-input wide"
                      value={draft.sshConfig?.authType || "password"}
                      onChange={(e) => setSSH({ authType: e.target.value as "password" | "key" })}
                    >
                      <option value="password">{t('connection.passwordAuth')}</option>
                      <option value="key">{t('connection.keyAuth')}</option>
                    </select>
                  </label>

                  {(draft.sshConfig?.authType ?? "password") === "password" && (
                    <label className="field">
                      <FieldLabel {...fieldLabelProps} required tip={t('connection.sshPasswordHelp')}>{t('connection.sshPassword')}</FieldLabel>
                      <div className="pwd-field">
                        <input
                          className="search-input wide mono"
                          type={showSSHPwd ? "text" : "password"}
                          value={draft.sshConfig?.password || ""}
                          onChange={(e) => setSSH({ password: e.target.value })}
                        />
                        <button
                          type="button"
                          className="pwd-toggle"
                          title={showSSHPwd ? t('connection.hide') : t('connection.show')}
                          onClick={() => setShowSSHPwd((v) => !v)}
                        >
                          {showSSHPwd ? "🙈" : "👁"}
                        </button>
                      </div>
                    </label>
                  )}

                  {draft.sshConfig?.authType === "key" && (
                    <>
                      <label className="field">
                        <FieldLabel {...fieldLabelProps} required tip={t('connection.privateKeyHelp')}>{t('connection.privateKey')}</FieldLabel>
                        <textarea
                          className="search-input wide mono ssh-key"
                          value={draft.sshConfig?.privateKey || ""}
                          placeholder="-----BEGIN RSA PRIVATE KEY-----"
                          onChange={(e) => setSSH({ privateKey: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <FieldLabel {...fieldLabelProps} tip={t('connection.privateKeyPasswordHelp')}>{t('connection.privateKeyPassword')}</FieldLabel>
                        <div className="pwd-field">
                          <input
                            className="search-input wide mono"
                            type={showSSHPassphrase ? "text" : "password"}
                            value={draft.sshConfig?.passphrase || ""}
                            onChange={(e) => setSSH({ passphrase: e.target.value })}
                          />
                          <button
                            type="button"
                            className="pwd-toggle"
                            title={showSSHPassphrase ? t('connection.hide') : t('connection.show')}
                            onClick={() => setShowSSHPassphrase((v) => !v)}
                          >
                            {showSSHPassphrase ? "🙈" : "👁"}
                          </button>
                        </div>
                      </label>
                    </>
                  )}

                  <label className="field">
                    <FieldLabel {...fieldLabelProps} tip={t('connection.localPortHelp')}>{t('connection.localPort')}</FieldLabel>
                    <input
                      className="search-input mono"
                      type="number"
                      value={draft.sshConfig?.localPort || ""}
                      placeholder={t('connection.localPortPlaceholder')}
                      onChange={(e) => setSSH({ localPort: parseInt(e.target.value) || undefined })}
                    />
                  </label>

                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={saveInlineSSHAsProfile}
                  >
                    {t('connection.sshProfileSave')}
                  </button>

                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setDraft((d) => ({ ...d, sshConfig: undefined, sshProfileId: "" }));
                      setShowSSHConfig(false);
                    }}
                  >
                    {t('connection.removeSSH')}
                  </button>
                    </>
                  )}
                </div>
              )}
            </div>}

            {visibleTestTrace ? (
              <TestTraceView trace={visibleTestTrace} />
            ) : visibleTestMsg && (
              <div className={`test-msg ${visibleTestMsg.ok ? "ok" : "err"}`}>
                <span className="test-msg-text" title={visibleTestMsg.text}>{displayTestMessage(visibleTestMsg.text)}</span>
                {!visibleTestMsg.ok && <CopyButton text={visibleTestMsg.text} label="复制报错" />}
              </div>
            )}

            <div className="conn-form-actions">
              <button className="btn btn-ghost" onClick={doTest} disabled={testingCurrent}>
                {testingCurrent ? t('connection.testing') : t('connection.test')}
              </button>
              <div className="spacer" />
              {draft.id && (
                <button className="btn btn-ghost" onClick={() => startNew()}>
                  {t('connection.new')}
                </button>
              )}
              <button className="btn btn-primary" onClick={save}>
                {t('common.save')}
              </button>
            </div>
          </div>
      </div>
    </>
  );

  if (embedded) {
    return <div className="page-surface connection-page">{content}</div>;
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {content}
    </div>
    </div>
  );
}
