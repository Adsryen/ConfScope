import { installAuditBridge } from "./lib/auditBootstrap";
import { bootstrapAppDataDoc, installAppDataDocSync } from "./lib/appDataDoc";
import React from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "./i18n";
import App from "./App";
import "./styles.css";

installAuditBridge();
void (async () => {
  try {
    // 主数据文件引导：文件优先水合 localStorage 缓存；失败时静默回退缓存
    await bootstrapAppDataDoc();
  } catch {
    // 数据文件读取异常时回退 localStorage 缓存
  }
  installAppDataDocSync();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <I18nProvider>
        <App />
      </I18nProvider>
    </React.StrictMode>
  );
})();
