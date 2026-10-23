import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  attachUpdateImage,
  checkForUpdates,
  downloadUpdate,
  getAppInfo,
  getDownloadProgress,
  getUpdateInstallCommand,
  launchUpdateInstaller,
  listActiveSSHTunnels,
  quitApplication,
  revealDownloadedArtifact,
  type AppInfo,
  type DownloadProgress,
  type UpdateCheckResult,
  type UpdateHandoff,
} from "../api/app";
import { getTaskManager } from "../lib/taskmanager";
import { pushAppDataDocument } from "../lib/appDataDoc";
import { useTranslation } from "../i18n";
import { reportError } from "../lib/errorCenter";
import CopyButton from "./CopyButton";
import { loadSettings, updateUpdateSettings } from "../store/settings";
import { EscapePriority, useEscape } from "../lib/useEscape";
import { useDialogFocus } from "../lib/useDialogFocus";
import { useOverlayDismiss } from "../lib/useOverlayDismiss";
import { errorText } from "../lib/errorText";
import { statusMessageProps } from "../lib/statusSemantics";
import { openExternalLink } from "../lib/externalLink";
import ExternalLink from "./ExternalLink";

interface AboutProps {
  onClose?: () => void;
  embedded?: boolean;
}

/*
 * 更新链路只有一条：检查 → 下载 → 校验 → 交接。
 *
 * 为什么没有"下载"这一步的独立按钮：轮62 之前用户点完检查还得再点下载、点完下载
 * 还得自己找文件，四步里有三步是人在替程序做决定；现在一次点击走到底，
 * 唯一保留的人工闸门是 ready 阶段的"现在是否退出"（只有 Windows 安装版会用到）。
 * verifying 不是假状态：Go 侧的 done 事件只在校验通过后才发（fail closed），
 * 进度到 100% 而 done 未到，就是真在校验。
 */
type UpdatePhase = "idle" | "checking" | "upToDate" | "updateAvailable" | "downloading" | "verifying" | "ready" | "error";

interface WailsRuntime {
  EventsOn?: (eventName: string, callback: (progress: DownloadProgress) => void) => void;
  EventsOff?: (eventName: string) => void;
}

type WindowWithRuntime = Window & { runtime?: WailsRuntime };

export default function About({ onClose = () => {}, embedded = false }: AboutProps) {
  const { t } = useTranslation();
  const [appInfo, setAppInfo] = useState<AppInfo>({
    name: "ConfScope",
    version: "1.0.0",
    updateSources: [],
  });
  const [appInfoLoaded, setAppInfoLoaded] = useState(false);
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>("idle");
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  // 轮67 R67-WP2：被忽略的版本不能只在「忽略」那一刻生效完就消失。
  // 关于页读它才能把「已是最新」说清是「本来就最新」还是「被你忽略过」；
  // 这一页是按 mode 挂载的（离开即卸载），挂载时读一次就是新读数，不会停在旧值。
  const [skippedVersion, setSkippedVersion] = useState(() => loadSettings().update.skipVersion);
  // 交接三件事实：落盘路径（Go 给的，不猜）、包管理器命令（Go 拼的，不抄）、忙碌闸门读数（点退出时才查）
  const [artifactPath, setArtifactPath] = useState("");
  const [handoffCommand, setHandoffCommand] = useState("");
  const [busyReasons, setBusyReasons] = useState<string[]>([]);
  const [handoffError, setHandoffError] = useState("");
  const [quitting, setQuitting] = useState(false);

  // Esc 关闭弹框改用分层注册表：散装监听会在冒泡阶段抢 Esc，
  // 连带关掉它下面的弹层（下拉/确认框），一次 Esc 只该关最内层。
  useEscape(!embedded, onClose, EscapePriority.overlay);

  // 焦点陷阱：内嵌在设置页里时它不是弹层，不该吃掉页面其余部分的 Tab。
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogFocus({ active: !embedded, containerRef: modalRef });
  const overlayDismiss = useOverlayDismiss(onClose);

  useEffect(() => {
    let alive = true;
    getAppInfo()
      .then((info) => {
        if (alive) {
          setAppInfo(info);
          setAppInfoLoaded(true);
        }
      })
      .catch(() => {
        if (alive) {
          setAppInfo({ name: "ConfScope", version: "1.0.0", updateSources: [] });
          setAppInfoLoaded(true);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  // 监听 Wails 下载进度事件 + 轮询 fallback
  useEffect(() => {
    if (updatePhase !== "downloading" && updatePhase !== "verifying") return;

    let cleanup: (() => void) | undefined;

    const applyProgress = (p: DownloadProgress) => {
      setDownloadProgress(p);
      if (p.error) {
        setErrorMessage(p.error);
        setUpdatePhase("error");
        return;
      }
      // done 只在校验通过后由 Go 发出：以它为准切到交接面板
      if (p.done) setUpdatePhase("ready");
      else if (p.percent >= 100) setUpdatePhase("verifying");
    };

    // 尝试使用 Wails 事件系统
    const runtime = (window as WindowWithRuntime).runtime;
    if (runtime?.EventsOn) {
      runtime.EventsOn("update:download-progress", applyProgress);
      cleanup = () => {
        if (runtime.EventsOff) runtime.EventsOff("update:download-progress");
      };
    }

    // 轮询作为 fallback
    const timer = setInterval(async () => {
      try {
        const p = await getDownloadProgress();
        applyProgress(p);
        if (p.done || p.error) {
          if (timer) clearInterval(timer);
        }
      } catch {
        // 忽略轮询错误
      }
    }, 300);

    return () => {
      if (cleanup) cleanup();
      if (timer) clearInterval(timer);
    };
  }, [updatePhase]);

  const startDownload = useCallback(
    async (result: UpdateCheckResult) => {
      if (!result.downloadUrl) return;
      setUpdatePhase("downloading");
      setDownloadProgress(null);
      setErrorMessage("");
      setArtifactPath("");
      setHandoffCommand("");
      setBusyReasons([]);
      try {
        const settings = loadSettings();
        // 代理必须与检查同源：过去下载直连，直连不通的人查得到版本却下不动包
        const path = await downloadUpdate(result.downloadUrl, result.sha256, settings.proxy);
        setArtifactPath(path);
        if (result.handoff === "command") {
          setHandoffCommand(await getUpdateInstallCommand(path));
        }
        setUpdatePhase("ready");
      } catch (e) {
        const msg = errorText(e);
        setErrorMessage(msg);
        setUpdatePhase("error");
        reportError({
          title: t("about.updateDownloadFailed"),
          source: t("about.updateTitle"),
          message: msg,
          mergeKey: "update:download",
        });
      }
    },
    [t]
  );

  // 检查更新。autoDownload 区分"人按了按钮"和"页面自己开局顺手查了一次"：
  // 前者一路走到交接面板（用户要的就是这个），后者停在 updateAvailable——
  // 被动触发就悄悄吃掉几十 MB 流量，是拿用户的账单替程序省事。
  const runUpdateCheck = useCallback(
    async (options: { autoDownload?: boolean } = {}) => {
      setUpdatePhase("checking");
      setUpdateResult(null);
      setErrorMessage("");
      setBusyReasons([]);
      const settings = loadSettings();
      try {
        updateUpdateSettings({ lastCheckAt: new Date().toISOString() });
        const result = await checkForUpdates({
          currentVersion: appInfo.version,
          sources: appInfo.updateSources,
          proxy: settings.proxy,
        });
        setUpdateResult(result);
        updateUpdateSettings({
          lastSeenVersion: result.latestVersion || "",
        });
        if (result.error) {
          setErrorMessage(result.error);
          setUpdatePhase("error");
          reportError({
            title: t("about.updateCheckFailed"),
            source: t("about.updateTitle"),
            message: result.error,
            mergeKey: "update:check",
          });
        } else if (result.hasUpdate) {
          if (!result.mandatory && settings.update.skipVersion === result.latestVersion) {
            setUpdatePhase("upToDate");
          } else if (options.autoDownload && result.downloadUrl) {
            await startDownload(result);
          } else {
            setUpdatePhase("updateAvailable");
          }
        } else {
          setUpdatePhase("upToDate");
        }
      } catch (e) {
        const msg = errorText(e);
        setErrorMessage(msg);
        setUpdatePhase("error");
        reportError({
          title: t("about.updateCheckError"),
          source: t("about.updateTitle"),
          message: msg,
          mergeKey: "update:check",
        });
      }
    },
    [appInfo.updateSources, appInfo.version, startDownload, t]
  );

  const skipVersion = useCallback(() => {
    if (!updateResult?.latestVersion) return;
    updateUpdateSettings({ skipVersion: updateResult.latestVersion });
    setSkippedVersion(updateResult.latestVersion);
    setUpdatePhase("upToDate");
  }, [updateResult]);

  // 进入 About 页自动检查（如果距上次检查 > 6 小时或未检查过）
  useEffect(() => {
    if (!appInfoLoaded || updatePhase !== "idle") return;
    const settings = loadSettings();
    const lastCheck = settings.update.lastCheckAt ? new Date(settings.update.lastCheckAt).getTime() : 0;
    const hoursSinceCheck = (Date.now() - lastCheck) / 3600000;
    if (settings.update.lastCheckAt && hoursSinceCheck > 6) {
      runUpdateCheck();
    }
  }, [appInfoLoaded, runUpdateCheck, updatePhase]);

  // 桌面 webview 里 window.open 开不出窗口（R66），外链一律走共享出口：
  // 有 Wails 运行时就走系统浏览器，都不行时复制链接并提示，不再「点了没反应」。

  // 交接面板的说明文案按出路取，一条出路一句话，不把五种步骤糊在同一个框里。
  const handoffKey = (updateResult?.handoff || "page") as UpdateHandoff;

  // 官方 Release 页：manifest 的 sourceUrl 指向 update.json，直接打开给用户只看得到 JSON。
  const releasePageUrl = useMemo(() => {
    const source = updateResult?.sourceUrl || "";
    const match = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/releases\/.*$/.exec(source);
    if (match) return `${match[1]}/releases`;
    return "https://github.com/Adsryen/ConfScope/releases";
  }, [updateResult?.sourceUrl]);

  const openReleasePage = useCallback(() => {
    void openExternalLink(releasePageUrl);
  }, [releasePageUrl]);

  // 忙碌闸门的三个事实源，全都取既有的唯一出口：任务表（写入还在跑）、
  // 隧道表（在 Go 侧）、主数据落盘（pushAppDataDocument 的成功与否）。
  const collectBusyReasons = useCallback(async (): Promise<string[]> => {
    const reasons: string[] = [];
    const running = getTaskManager()
      .listTasks()
      .filter((task) => task.status === "running" || task.status === "pending");
    for (const task of running) {
      reasons.push(t("about.busyTask", { name: task.name }));
    }
    try {
      const tunnels = await listActiveSSHTunnels();
      if (tunnels.length > 0) {
        reasons.push(t("about.busyTunnels", { count: tunnels.length, ids: tunnels.join(", ") }));
      }
    } catch {
      // 读不到隧道表（非桌面运行时）：不拿它当理由，交给后面的落盘与退出步骤去报真错
    }
    return reasons;
  }, [t]);

  // 唯一的人工闸门：现在退出并交给安装程序。
  // 顺序是硬的——先确认没有在写的任务与隧道，再强制落盘，最后才允许退出；
  // 落盘失败绝不退出（主数据是 debounce 写的，带着未落盘的改动退出等于吃掉最后一次变更）。
  const quitAndInstall = useCallback(async () => {
    if (quitting) return;
    setBusyReasons([]);
    setHandoffError("");
    const reasons = await collectBusyReasons();
    if (reasons.length > 0) {
      setBusyReasons(reasons);
      return;
    }
    const flushed = await pushAppDataDocument({ report: false });
    if (!flushed) {
      setBusyReasons([t("about.busyDataFlush")]);
      return;
    }
    setQuitting(true);
    try {
      await launchUpdateInstaller(artifactPath);
      await quitApplication();
    } catch (e) {
      setQuitting(false);
      setHandoffError(`${errorText(e)}｜${t("about.manualQuitHint")}`);
    }
  }, [artifactPath, collectBusyReasons, quitting, t]);

  const runHandoff = useCallback(
    async (action: (path: string) => Promise<void>) => {
      setHandoffError("");
      try {
        await action(artifactPath);
      } catch (e) {
        setHandoffError(errorText(e));
      }
    },
    [artifactPath]
  );

  // 进度条：downloading / verifying / ready 共用同一个结构（role + aria 值不能少）
  const renderProgress = (label: string) => (
    <div className="update-downloading">
      <div
        className="update-progress-bar"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={downloadProgress?.percent ?? 0}
      >
        <div className="update-progress-fill" style={{ width: `${downloadProgress?.percent ?? 0}%` }} />
      </div>
      <div className="update-progress-text">
        {(downloadProgress?.total ?? 0) > 0
          ? `${((downloadProgress?.downloaded ?? 0) / 1024 / 1024).toFixed(1)} MB / ${((downloadProgress?.total ?? 0) / 1024 / 1024).toFixed(1)} MB`
          : label}
        <span className="update-progress-pct">{downloadProgress?.percent ?? 0}%</span>
      </div>
    </div>
  );

  // 交接面板：一条出路一套动作。安装版给"退出并安装"闸门，其余给人工步骤。
  const renderHandoffPanel = () => {
    const result = updateResult;
    if (!result) return null;
    const sizeText =
      (downloadProgress?.total ?? 0) > 0 ? `${((downloadProgress?.total ?? 0) / 1024 / 1024).toFixed(1)} MB` : "";

    return (
      <div className="update-handoff">
        <div className="test-msg ok" {...statusMessageProps("success")}>
          <span className="test-msg-text">{t("about.downloadComplete")}</span>
        </div>
        <div className="update-handoff-meta">
          <div className="update-handoff-line">
            <span className="update-handoff-label">{t("about.handoffArtifact")}</span>
            <code className="update-artifact-path" title={artifactPath || result.fileName}>
              {artifactPath || result.fileName || "-"}
            </code>
          </div>
          {sizeText && (
            <div className="update-handoff-line">
              <span className="update-handoff-label">{t("about.handoffSize")}</span>
              <span>{sizeText}</span>
            </div>
          )}
          {result.downgraded && <div className="update-handoff-note">{t("about.downgradedNotice")}</div>}
          <div className="update-handoff-note">{t(`about.handoff.${handoffKey}`)}</div>
        </div>

        {handoffKey === "installer" && (
          <div className="update-actions">
            <button className="btn btn-primary btn-sm" onClick={quitAndInstall} disabled={quitting}>
              {quitting ? t("about.quitting") : t("about.quitAndInstall")}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => void runHandoff(revealDownloadedArtifact)}>
              {t("about.revealFolder")}
            </button>
          </div>
        )}

        {handoffKey === "reveal" && (
          <div className="update-actions">
            <button className="btn btn-primary btn-sm" onClick={() => void runHandoff(revealDownloadedArtifact)}>
              {t("about.revealFolder")}
            </button>
          </div>
        )}

        {handoffKey === "command" && (
          <div className="update-handoff-command">
            <code title={handoffCommand}>{handoffCommand || t("about.noHandoffCommand")}</code>
            {handoffCommand && <CopyButton text={handoffCommand} />}
          </div>
        )}

        {handoffKey === "image" && (
          <div className="update-actions">
            <button className="btn btn-primary btn-sm" onClick={() => void runHandoff(attachUpdateImage)}>
              {t("about.mountImage")}
            </button>
          </div>
        )}

        {handoffKey === "page" && (
          <div className="update-actions">
            <button className="btn btn-primary btn-sm" onClick={openReleasePage}>
              {t("about.openDownload")}
            </button>
          </div>
        )}

        {busyReasons.length > 0 && (
          <div className="update-busy" role="alert">
            <div className="update-busy-title">{t("about.busyBlocked")}</div>
            <ul className="update-busy-list">
              {busyReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        )}

        {handoffError && (
          <div className="test-msg err" {...statusMessageProps("error")}>
            <span className="test-msg-text">{handoffError}</span>
          </div>
        )}
      </div>
    );
  };

  const renderUpdateSection = () => {
    switch (updatePhase) {
      case "idle":
        return (
          <button className="btn btn-primary btn-sm" onClick={() => void runUpdateCheck({ autoDownload: true })}>
            {t("about.checkUpdate")}
          </button>
        );

      case "checking":
        return (
          <button className="btn btn-primary btn-sm" disabled>
            {t("about.checkingUpdate")}
          </button>
        );

      case "upToDate":
        return (
          <>
            <div className="test-msg ok" {...statusMessageProps("success")}>
              <span className="test-msg-text">
                {skippedVersion ? t("about.noUpdateIgnored", { version: skippedVersion }) : t("about.noUpdate")}
              </span>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => void runUpdateCheck({ autoDownload: true })}>
              {t("about.checkUpdate")}
            </button>
          </>
        );

      case "updateAvailable":
        return (
          <>
            <div className="test-msg ok" {...statusMessageProps("success")}>
              <div className="test-msg-text">
                <div>{t("about.updateAvailable", { version: updateResult!.latestVersion })}</div>
                {updateResult!.sourceName && <div>{t("about.updateSourceHit", { source: updateResult!.sourceName })}</div>}
                {updateResult!.releaseNotes && (
                  <div className="update-release-notes" tabIndex={0} role="region" aria-label={t("about.releaseNotes")}>
                    {updateResult!.releaseNotes}
                  </div>
                )}
              </div>
            </div>
            {/* 清单里没有适配本机的产物时「下载并安装」是无从谈起的：
                这一档只能人去 Release 页挑，摆一颗点了没反应的按钮正是本文件在删的东西。 */}
            {!updateResult!.downloadUrl && (
              <div className="update-handoff-note">{t("about.handoff.page")}</div>
            )}
            <div className="update-actions">
              {updateResult!.downloadUrl ? (
                <button className="btn btn-primary btn-sm" onClick={() => void startDownload(updateResult!)}>
                  {t("about.downloadAndInstall", { version: updateResult!.latestVersion })}
                </button>
              ) : (
                <button className="btn btn-primary btn-sm" onClick={openReleasePage}>
                  {t("about.openDownload")}
                </button>
              )}
              {!updateResult!.mandatory && (
                <button className="btn btn-ghost btn-sm" onClick={skipVersion}>
                  {t("about.skipVersion")}
                </button>
              )}
            </div>
          </>
        );

      case "downloading":
        return renderProgress(t("about.downloadingUpdate"));

      case "verifying":
        return renderProgress(t("about.verifyingUpdate"));

      case "ready":
        return renderHandoffPanel();

      case "error":
        return (
          <>
            <div className="test-msg err" {...statusMessageProps("error")}>
              <span className="test-msg-text">{errorMessage}</span>
            </div>
            <div className="update-actions">
              <button className="btn btn-primary btn-sm" onClick={() => void runUpdateCheck({ autoDownload: true })}>
                {t("common.retry")}
              </button>
              {/* 用共享 CopyButton：复制成功/失败都有反馈（轮6 R51，原来是 fire-and-forget） */}
              <CopyButton text={errorMessage} />
            </div>
          </>
        );
    }
  };

  const content = (
    <>
      <div className="about-header">
        <div className="about-logo">
          <img
            src="/appicon.png"
            alt="ConfScope"
            className="about-icon"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
              const fallback = document.createElement("div");
              fallback.className = "about-icon-fallback";
              fallback.textContent = "CS";
              (e.target as HTMLImageElement).parentNode?.appendChild(fallback);
            }}
          />
        </div>
        <h2 id={titleId}>{appInfo.name}</h2>
        <p className="about-tagline">{t("about.tagline")}</p>
        <p className="about-version">v{appInfo.version}</p>
      </div>

      <div className="about-content">
        <div className="about-section about-full">
          <h3>{t("about.updateTitle")}</h3>
          <div className="update-body">{renderUpdateSection()}</div>
          <div className="update-source-list">
            {(appInfo.updateSources.length ? appInfo.updateSources : []).map((source) => (
              <span className="badge badge-planned" key={`${source.name}:${source.url}`} title={source.url}>
                {source.name}
              </span>
            ))}
          </div>
        </div>

        <div className="about-section">
          <h3>{t("about.features")}</h3>
          <ul>
            <li>{t("about.feature1")}</li>
            <li>{t("about.feature2")}</li>
            <li>{t("about.feature3")}</li>
            <li>{t("about.feature4")}</li>
            <li>{t("about.feature5")}</li>
          </ul>
        </div>

        <div className="about-section">
          <h3>{t("about.techStack")}</h3>
          <ul>
            <li>{t("about.tech1")}</li>
            <li>{t("about.tech2")}</li>
            <li>{t("about.tech3")}</li>
          </ul>
        </div>

        <div className="about-section about-full">
          <h3>{t("about.supportedCenters")}</h3>
          <div className="about-badges">
            <span className="badge badge-success">{t("about.centerNacos")}</span>
            <span className="badge badge-success">{t("about.centerApolloReadOnly")}</span>
            <span className="badge badge-success">{t("about.centerConsulReadOnly")}</span>
          </div>
        </div>

        <div className="about-section about-full about-links">
          <ExternalLink href="https://github.com/Adsryen/ConfScope" className="btn btn-ghost btn-sm">
            ⭐ GitHub
          </ExternalLink>
          <ExternalLink href="https://github.com/Adsryen/ConfScope/issues" className="btn btn-ghost btn-sm">
            {t("about.feedback")}
          </ExternalLink>
        </div>
      </div>

      <div className="about-footer">
        <p>
          Made with ❤️ by <ExternalLink href="https://github.com/Adsryen">Adsryen</ExternalLink>
        </p>
        {!embedded && (
          <button className="btn btn-primary" onClick={onClose}>
            {t("about.close")}
          </button>
        )}
      </div>
    </>
  );

  if (embedded) {
    return <div className="page-surface about-page">{content}</div>;
  }

  return (
    <div className="modal-overlay" {...overlayDismiss}>
      <div
        ref={modalRef}
        className="modal about-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        {content}
      </div>
    </div>
  );
}
