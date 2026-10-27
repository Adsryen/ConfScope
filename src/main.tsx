import { installAuditBridge } from "./lib/auditBootstrap";
import { bootstrapAppDataDoc, installAppDataDocSync } from "./lib/appDataDoc";
import React from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "./i18n";
import App from "./App";
import AppErrorBoundary from "./components/AppErrorBoundary";
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
  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
  // 边界放在 I18nProvider 里面：兜底界面自己也要出文案、也要用 CopyButton，
  // 那些都依赖 provider。放在外面反而会在最该说话的时候一起抛错（轮95 R3）。
  root.render(
    <React.StrictMode>
      <I18nProvider>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </I18nProvider>
    </React.StrictMode>
  );
})();
