import { useCallback, useEffect, useState } from "react";
import {
  checkForUpdates,
  downloadUpdate,
  getAppInfo,
  getDownloadProgress,
  type AppInfo,
  type DownloadProgress,
  type UpdateCheckResult,
} from "../api/app";
import { useTranslation } from "../i18n";
import { copyText } from "../lib/clipboard";
import { reportError } from "../lib/errorCenter";
import { loadSettings, updateUpdateSettings } from "../store/settings";

interface AboutProps {
  onClose?: () => void;
  embedded?: boolean;
}

type UpdatePhase = "idle" | "checking" | "upToDate" | "updateAvailable" | "downloading" | "downloaded" | "error";

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

  useEffect(() => {
    if (embedded) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [embedded, onClose]);

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
    if (updatePhase !== "downloading") return;

    let cleanup: (() => void) | undefined;

    // 尝试使用 Wails 事件系统
    const runtime = (window as WindowWithRuntime).runtime;
    if (runtime?.EventsOn) {
      const handler = (p: DownloadProgress) => {
        setDownloadProgress(p);
        if (p.done) setUpdatePhase("downloaded");
        if (p.error) {
          setErrorMessage(p.error);
          setUpdatePhase("error");
        }
      };
      runtime.EventsOn("update:download-progress", handler);
      cleanup = () => {
        if (runtime.EventsOff) runtime.EventsOff("update:download-progress");
      };
    }

    // 轮询作为 fallback
    const timer = setInterval(async () => {
      try {
        const p = await getDownloadProgress();
        setDownloadProgress(p);
        if (p.done) {
          setUpdatePhase("downloaded");
          if (timer) clearInterval(timer);
        }
        if (p.error) {
          setErrorMessage(p.error);
          setUpdatePhase("error");
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

  const runUpdateCheck = useCallback(async () => {
    setUpdatePhase("checking");
    setUpdateResult(null);
    setErrorMessage("");
    const settings = loadSettings();
    try {
      updateUpdateSettings({ lastCheckAt: new Date().toISOString() });
      const result = await checkForUpdates({
        currentVersion: appInfo.version,
        sources: appInfo.updateSources,
        proxy: settings.proxy,
      });
      setUpdateResult(result);
      // 保存检查状态（lastCheckAt 已在检查入口记录）
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
        // 如果已忽略此版本且非 mandatory，跳过提示
        if (!result.mandatory && settings.update.skipVersion === result.latestVersion) {
          setUpdatePhase("upToDate");
        } else {
          setUpdatePhase("updateAvailable");
        }
      } else {
        setUpdatePhase("upToDate");
      }
    } catch (e) {
      const msg = String(e);
      setErrorMessage(msg);
      setUpdatePhase("error");
      reportError({
        title: t("about.updateCheckError"),
        source: t("about.updateTitle"),
        message: msg,
        mergeKey: "update:check",
      });
    }
  }, [appInfo.version, appInfo.updateSources, t]);

  const skipVersion = useCallback(() => {
    if (!updateResult?.latestVersion) return;
    updateUpdateSettings({ skipVersion: updateResult.latestVersion });
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

  const startDownload = useCallback(async () => {
    if (!updateResult?.downloadUrl) return;
    setUpdatePhase("downloading");
    setDownloadProgress(null);
    setErrorMessage("");
    try {
      await downloadUpdate(updateResult.downloadUrl, updateResult.sha256);
      setUpdatePhase("downloaded");
    } catch (e) {
      const msg = String(e);
      setErrorMessage(msg);
      setUpdatePhase("error");
      reportError({
        title: t("about.updateDownloadFailed"),
        source: t("about.updateTitle"),
        message: msg,
        mergeKey: "update:download",
      });
    }
  }, [updateResult, t]);

  const openDownloadPage = useCallback(() => {
    const url = updateResult?.downloadUrl || updateResult?.sourceUrl;
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  }, [updateResult]);

  const renderUpdateSection = () => {
    switch (updatePhase) {
      case "idle":
        return (
          <button className="btn btn-primary btn-sm" onClick={runUpdateCheck}>
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
            <div className="test-msg ok">
              <span className="test-msg-text">{t("about.noUpdate")}</span>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={runUpdateCheck}>
              {t("about.checkUpdate")}
            </button>
          </>
        );

      case "updateAvailable":
        return (
          <>
            <div className="test-msg ok">
              <div className="test-msg-text">
                <div>{t("about.updateAvailable", { version: updateResult!.latestVersion })}</div>
                {updateResult!.sourceName && <div>{t("about.updateSourceHit", { source: updateResult!.sourceName })}</div>}
                {updateResult!.releaseNotes && <div className="update-release-notes">{updateResult!.releaseNotes}</div>}
              </div>
            </div>
            <div className="update-actions">
              <button className="btn btn-primary btn-sm" onClick={startDownload}>
                {t("about.downloadUpdate")}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={runUpdateCheck}>
                {t("about.checkUpdate")}
              </button>
              {!updateResult!.mandatory && (
                <button className="btn btn-ghost btn-sm" onClick={skipVersion}>
                  {t("about.skipVersion")}
                </button>
              )}
            </div>
          </>
        );

      case "downloading":
        return (
          <div className="update-downloading">
            <div className="update-progress-bar">
              <div className="update-progress-fill" style={{ width: `${downloadProgress?.percent ?? 0}%` }} />
            </div>
            <div className="update-progress-text">
              {(downloadProgress?.total ?? 0) > 0
                ? `${((downloadProgress?.downloaded ?? 0) / 1024 / 1024).toFixed(1)} MB / ${((downloadProgress?.total ?? 0) / 1024 / 1024).toFixed(1)} MB`
                : t("about.downloadingUpdate")}
              <span className="update-progress-pct">{downloadProgress?.percent ?? 0}%</span>
            </div>
          </div>
        );

      case "downloaded":
        return (
          <>
            <div className="test-msg ok">
              <span className="test-msg-text">{t("about.downloadComplete")}</span>
            </div>
            {(updateResult?.downloadUrl || updateResult?.sourceUrl) && (
              <button className="btn btn-primary btn-sm" onClick={openDownloadPage}>
                {t("about.openDownload")}
              </button>
            )}
          </>
        );

      case "error":
        return (
          <>
            <div className="test-msg err">
              <span className="test-msg-text">{errorMessage}</span>
            </div>
            <div className="update-actions">
              <button className="btn btn-primary btn-sm" onClick={runUpdateCheck}>
                {t("common.retry")}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => copyText(errorMessage)}>
                {t("common.copy")}
              </button>
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
        <h2>{appInfo.name}</h2>
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
          <a href="https://github.com/Adsryen/ConfScope" target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm">
            ⭐ GitHub
          </a>
          <a href="https://github.com/Adsryen/ConfScope/issues" target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm">
            {t("about.feedback")}
          </a>
        </div>
      </div>

      <div className="about-footer">
        <p>
          Made with ❤️ by{" "}
          <a href="https://github.com/Adsryen" target="_blank" rel="noopener noreferrer">
            Adsryen
          </a>
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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal about-modal" onClick={(e) => e.stopPropagation()}>
        {content}
      </div>
    </div>
  );
}
