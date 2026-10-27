import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "../i18n";
import { translate } from "../locales";
import { reportError } from "../lib/errorCenter";
import { appendAuditEvent } from "../lib/auditSession";
import CopyButton from "./CopyButton";

interface Props {
  children: ReactNode;
}

interface State {
  /** 捕获到的渲染期错误；null 表示界面正常。 */
  error: Error | null;
  /** React 给出的组件栈（`componentStack`），出错在哪个组件全在这一串里。 */
  componentStack: string;
  /**
   * 登记出去的那一份诊断文本。空串表示还没算过（`componentDidCatch` 之前会有一次渲染）。
   *
   * 为什么要存下来而不是各自算：界面上抄走的文字与消息中心/审计里留痕的那一条，
   * 时间戳差一毫秒都对不上，用户照着界面反馈、维护者照着登记簿排查就是两套信息。
   */
  diagnostics: string;
}

/**
 * 把一次渲染期抛错整理成「读得完、也抄得走」的那一段文本。
 *
 * 为什么收在这里而不是各自拼：消息中心那条与界面上那段必须是**同一份**文字，
 * 否则用户照着界面反馈、我们照着消息中心排查，两套信息对不上（轮95 R3）。
 * 不截断：组件栈的尾部正是「哪个页面」，截断等于把定位能力剪掉。
 *
 * 小标题也走文案：英文界面下崩了却甩出一串中文「发生时间」，等于把诊断信息
 * 的一半藏起来（用户抄回去自己也读不懂）。
 */
export function buildCrashDiagnostics(error: Error, componentStack: string, at: Date): string {
  const head = `${error.name}: ${error.message ?? ""}`.trim();
  const stack = error.stack ? `\n\n${error.stack}` : "";
  const stackLabel = translate("crash.stackLabel");
  const component = componentStack
    ? `\n\n${stackLabel}:\n${componentStack.trim()}`
    : `\n\n${stackLabel}: ${translate("crash.stackNone")}`;
  return `${head}${stack}${component}\n\n${translate("crash.timeLabel")}: ${at.toISOString()}`;
}

/**
 * 崩溃兜底界面。
 *
 * 它是**独立函数组件**，因为 `CopyButton` 与全站文案都吃 `useTranslation()`：
 * 只要它还挂在 `I18nProvider` 里面，就能照常出中文/英文，也不引入新的读盘或绑定调用。
 * 三条硬要求（轮95 R3）：看得见（不依赖被卸载的那棵树）、读得完（不截断）、复制得了。
 */
function CrashFallback({ diagnostics, onReload }: { diagnostics: string; onReload: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="app-crash" role="alert">
      <div className="app-crash-head">
        <div className="app-crash-title">{t("crash.title")}</div>
        <div className="app-crash-actions">
          <button className="btn btn-primary btn-sm" onClick={onReload}>
            {t("crash.reload")}
          </button>
          <CopyButton text={diagnostics} label={t("crash.copy")} ariaLabel={t("crash.copyAria")} />
        </div>
      </div>
      <p className="app-crash-lead">{t("crash.lead")}</p>
      <p className="app-crash-hint">{t("crash.reloadHint")}</p>
      <div className="app-crash-detail-label">{t("crash.detail")}</div>
      {/* 诊断正文是整块里最长的东西：只给滚轮不给键盘，键盘用户就读不到后半段（R39 口径）。
         可访问名直接复用上面那行标题文字，两处永远一致。 */}
      <pre className="app-crash-detail" tabIndex={0} role="region" aria-label={t("crash.detail")}>
        {diagnostics}
      </pre>
      <p className="app-crash-hint">{t("crash.again")}</p>
    </div>
  );
}

/**
 * 根错误边界：界面任何一处渲染期抛错，最坏的后果只能降级成这一块兜底界面。
 *
 * 为什么非要有这一层（轮94 实测，不是假想风险）：`src/main.tsx` 原先没有任何 ErrorBoundary，
 * 而 wailsjs 的绑定包装是同步取方法 —— 复测桥少一个名字，`About` 挂载时当场 TypeError，
 * 抛穿 render/effect 后 React 把 `#root` 的children 全删了。用户看到的是一张白屏：
 * 没有提示、没有按钮、没有可读信息，连「出事了」这件事都不告诉他。
 *
 * 兜底面自己**不碰**的东西：不读主数据文件、不调 wailsjs 绑定、不读 localStorage 之外的状态。
 * 它是在别的代码正在抛错的时候唯一还要渲染的东西，任何额外依赖都可能让它一起抛。
 */
export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: "", diagnostics: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? "";
    const diagnostics = buildCrashDiagnostics(error, componentStack, new Date());
    this.setState({ componentStack, diagnostics });
    try {
      // 界面上已经当场说了一遍，这里只登记不抢即时通道（feedback-channels §6 第 4 问）。
      // `origin: "system"`：这不是用户那一下点击的结果，是程序自己出了问题。
      reportError({
        title: translate("crash.messageTitle"),
        message: `${error.name}: ${error.message ?? ""}`.trim(),
        detail: diagnostics,
        source: "AppErrorBoundary",
        origin: "system",
        toast: false,
      });
      // 留痕：刷新后消息中心会清空，审计日志才是事后能查到的那份。
      appendAuditEvent({ kind: "ui_crash", result: "failure", error: diagnostics });
    } catch {
      // 登记失败绝不能把兜底界面自己也弄塌。
    }
  }

  private reload = (): void => {
    // remount，不重启进程：把子树换掉，让上层重新挂载一次（数据仍在本地，不丢）。
    this.setState({ error: null, componentStack: "", diagnostics: "" });
  };

  render(): ReactNode {
    const { error, componentStack, diagnostics } = this.state;
    if (error) {
      // 兜底界面显示的就是登记出去的那一份。`||` 右边只在 componentDidCatch
      // 落账前的那一渲染窗口生效（文本相同，只差时间戳），不是为了兜两种状态。
      return <CrashFallback diagnostics={diagnostics || buildCrashDiagnostics(error, componentStack, new Date())} onReload={this.reload} />;
    }
    return this.props.children;
  }
}
