// 审计桥安装：把 auditSession 的 appendAuditEvent 接到
// wailsjs 绑定 AppendAuditEvent（原生应用），或在 web 手动桥模式下
// 静默降级（window.__retestBinding 不存在时）。
// 必须在 main.tsx 最前面 import（side-effect），保证先于任何组件
// 记录事件时 bridge 已就位。
import { AppendAuditEvent } from "../../wailsjs/go/app/App";

type AuditBridgeWindow = Window & {
  __auditBridge?: { appendAuditEvent: (payload: unknown) => void };
};

let installed = false;

export function installAuditBridge(): void {
  if (installed) return;
  installed = true;
  const win = window as AuditBridgeWindow;
  if (win.__auditBridge) return; // 测试/manual bridge 可能已注入
  win.__auditBridge = {
    appendAuditEvent: (payload: unknown) => {
      try {
        const raw = JSON.stringify(payload);
        void AppendAuditEvent(raw);
      } catch {
        // 审计失败静默
      }
    },
  };
}
