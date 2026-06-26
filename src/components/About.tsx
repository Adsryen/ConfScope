import { useEffect } from "react";
import { useTranslation } from "../i18n";

interface AboutProps {
  onClose: () => void;
}

export default function About({ onClose }: AboutProps) {
  const { t } = useTranslation();

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [onClose]);

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
          <h2>ConfScope</h2>
          <p className="about-tagline">{t('about.tagline')}</p>
          <p className="about-version">v1.0.0</p>
        </div>

        <div className="about-content">
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
