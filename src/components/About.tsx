import { useEffect } from "react";

interface AboutProps {
  onClose: () => void;
}

export default function About({ onClose }: AboutProps) {
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
            <div className="about-icon">CS</div>
          </div>
          <h2>ConfScope</h2>
          <p className="about-tagline">统一配置中心管理工具</p>
          <p className="about-version">v1.0.0</p>
        </div>

        <div className="about-content">
          <div className="about-section">
            <h3>🎯 功能特性</h3>
            <ul>
              <li>🔗 多配置中心连接管理</li>
              <li>📖 配置浏览与搜索</li>
              <li>📜 历史版本查看</li>
              <li>🔍 智能配置对比（行级 diff）</li>
              <li>🔐 自动认证与 Token 管理</li>
            </ul>
          </div>

          <div className="about-section">
            <h3>🛠️ 技术栈</h3>
            <ul>
              <li>前端：React 18 + TypeScript + Vite 5</li>
              <li>后端：Go + Wails 2</li>
              <li>UI：深色 VSCode 风格</li>
            </ul>
          </div>

          <div className="about-section">
            <h3>📦 支持的配置中心</h3>
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
              🐛 反馈问题
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
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
