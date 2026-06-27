import { useEffect, useState } from "react";
import { checkForUpdates, getAppInfo, type AppInfo, type UpdateCheckResult } from "../api/app";
import { useTranslation } from "../i18n";
import { loadSettings, updateProxySettings, type ProxySettings } from "../store/settings";

interface AboutProps {
  onClose: () => void;
}

export default function About({ onClose }: AboutProps) {
  const { t } = useTranslation();
  const [appInfo, setAppInfo] = useState<AppInfo>({
    name: "ConfScope",
    version: "1.0.0",
    updateSources: [],
  });
  const [proxy, setProxy] = useState<ProxySettings>(() => loadSettings().proxy);
  const [checking, setChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    getAppInfo()
      .then((info) => {
        if (alive) setAppInfo(info);
      })
      .catch(() => {
        if (alive) {
          setAppInfo({ name: "ConfScope", version: "1.0.0", updateSources: [] });
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const setProxyField = (key: keyof ProxySettings, value: string) => {
    setProxy((current) => ({ ...current, [key]: value }));
  };

  const runUpdateCheck = async () => {
    setChecking(true);
    setUpdateResult(null);
    try {
      updateProxySettings(proxy);
    } catch {
      // localStorage can be unavailable; update checks should still work with in-memory proxy values.
    }
    try {
      const result = await checkForUpdates({
        currentVersion: appInfo.version,
        sources: appInfo.updateSources,
        proxy,
      });
      setUpdateResult(result);
    } catch (e) {
      setUpdateResult({
        currentVersion: appInfo.version,
        latestVersion: "",
        hasUpdate: false,
        sourceName: "",
        sourceUrl: "",
        downloadUrl: "",
        releaseNotes: "",
        publishedAt: "",
        sha256: "",
        mandatory: false,
        checkedAt: "",
        error: String(e),
      });
    } finally {
      setChecking(false);
    }
  };

  const openDownload = () => {
    if (!updateResult?.downloadUrl) return;
    window.open(updateResult.downloadUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal about-modal" onClick={(e) => e.stopPropagation()}>
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
          <p className="about-tagline">{t('about.tagline')}</p>
          <p className="about-version">v{appInfo.version}</p>
        </div>

        <div className="about-content">
          <div className="about-section">
            <h3>{t('about.updateTitle')}</h3>
            <div className="update-actions">
              <button className="btn btn-primary btn-sm" onClick={runUpdateCheck} disabled={checking}>
                {checking ? t('about.checkingUpdate') : t('about.checkUpdate')}
              </button>
              {updateResult?.hasUpdate && updateResult.downloadUrl && (
                <button className="btn btn-ghost btn-sm" onClick={openDownload}>
                  {t('about.openDownload')}
                </button>
              )}
            </div>
            {updateResult?.error && <div className="test-msg err">{updateResult.error}</div>}
            {updateResult && !updateResult.error && updateResult.hasUpdate && (
              <div className="test-msg ok">
                <div>{t('about.updateAvailable', { version: updateResult.latestVersion })}</div>
                {updateResult.sourceName && (
                  <div>{t('about.updateSourceHit', { source: updateResult.sourceName })}</div>
                )}
                {updateResult.releaseNotes && <div>{updateResult.releaseNotes}</div>}
              </div>
            )}
            {updateResult && !updateResult.error && !updateResult.hasUpdate && (
              <div className="test-msg ok">{t('about.noUpdate')}</div>
            )}
            <div className="update-source-list">
              {(appInfo.updateSources.length ? appInfo.updateSources : []).map((source) => (
                <span className="badge badge-planned" key={`${source.name}:${source.url}`} title={source.url}>
                  {source.name}
                </span>
              ))}
            </div>
            <div className="field-row update-proxy-row">
              <label className="field">
                <span>{t('about.httpProxy')}</span>
                <input
                  className="search-input"
                  value={proxy.httpProxy}
                  placeholder="http://127.0.0.1:7890"
                  onChange={(e) => setProxyField("httpProxy", e.target.value)}
                />
              </label>
              <label className="field">
                <span>{t('about.httpsProxy')}</span>
                <input
                  className="search-input"
                  value={proxy.httpsProxy}
                  placeholder="http://127.0.0.1:7890"
                  onChange={(e) => setProxyField("httpsProxy", e.target.value)}
                />
              </label>
              <label className="field">
                <span>{t('about.noProxy')}</span>
                <input
                  className="search-input"
                  value={proxy.noProxy}
                  placeholder="localhost,127.0.0.1"
                  onChange={(e) => setProxyField("noProxy", e.target.value)}
                />
              </label>
            </div>
          </div>

          <div className="about-section">
            <h3>{t('about.features')}</h3>
            <ul>
              <li>{t('about.feature1')}</li>
              <li>{t('about.feature2')}</li>
              <li>{t('about.feature3')}</li>
              <li>{t('about.feature4')}</li>
              <li>{t('about.feature5')}</li>
            </ul>
          </div>

          <div className="about-section">
            <h3>{t('about.techStack')}</h3>
            <ul>
              <li>{t('about.tech1')}</li>
              <li>{t('about.tech2')}</li>
              <li>{t('about.tech3')}</li>
            </ul>
          </div>

          <div className="about-section">
            <h3>{t('about.supportedCenters')}</h3>
            <div className="about-badges">
              <span className="badge badge-success">Nacos ✅</span>
              <span className="badge badge-planned">Apollo 🔜</span>
              <span className="badge badge-planned">Consul 🔜</span>
            </div>
          </div>

          <div className="about-section about-links">
            <a
              href="https://github.com/Adsryen/ConfScope"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost btn-sm"
            >
              ⭐ GitHub
            </a>
            <a
              href="https://github.com/Adsryen/ConfScope/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost btn-sm"
            >
              {t('about.feedback')}
            </a>
          </div>
        </div>

        <div className="about-footer">
          <p>
            Made with ❤️ by{" "}
            <a
              href="https://github.com/Adsryen"
              target="_blank"
              rel="noopener noreferrer"
            >
              Adsryen
            </a>
          </p>
          <button className="btn btn-primary" onClick={onClose}>
            {t('about.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
