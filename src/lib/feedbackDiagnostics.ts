// 反馈通道的排版层（轮80）。
//
// 为什么单独成文件：这段文本会被用户原样贴进公开 Issue，判据必须能脱离组件测。
// 更关键的是**输入只有 Go 给的 5 项事实 + 界面语言**——函数签名不收数据根路径、不收连接名、
// 不收命名空间/租户名、不收报错原文（那玩意儿经常带内网主机名）。想往反馈里塞私密信息就得先改签名，
// 改签名会被本文件的用例和 tests/ux/feedbackChannelStaysSanitized.test.ts 一起拦住。
//
// 为什么字段名用固定英文而不是 t()：这是给维护者读的诊断块，字段名中英各来一份就得各认一次；
// 界面语言本身作为其中一行报出去就够了。标题段落那些「给用户看的字」由调用方用 t() 传进来。
//
// 为什么不自动写剪贴板：早先的想法是点「反馈」时顺手把环境信息复制了，但那会覆盖用户
// 正在复制的东西且没有任何提示。改成把环境块预填进 Issue 正文，剪贴板只在用户明确点
// 「复制环境信息」时才动（与全站 CopyButton 同一个口径）。

/** 与 internal/app.FeedbackDiagnostics 一一对应的 5 项事实。 */
export interface FeedbackFacts {
  version: string;
  platform: string;
  runtimeMode: string;
  packageFormat: string;
  assetName: string;
}

/** 反馈落地处只准是自家仓库；写死在这里，免得哪天把用户带到别人的 issue 页。 */
export const FEEDBACK_REPO_URL = "https://github.com/Adsryen/ConfScope";

/**
 * 组装环境块。`packageFormat` 只在 Linux 上有值（deb/rpm），空就不占一行，
 * 免得 Windows/macOS 用户的 Issue 里挂着一行 `Package format:` 空值让人猜是不是出了 bug。
 */
export function buildFeedbackEnvironment(facts: FeedbackFacts, uiLocale: string): string {
  const lines = [
    `- ConfScope version: ${facts.version}`,
    `- Platform: ${facts.platform}`,
    `- Runtime mode: ${facts.runtimeMode}`,
    `- Package: ${facts.assetName}`,
    `- UI language: ${uiLocale}`,
  ];
  if (facts.packageFormat) lines.push(`- Package format: ${facts.packageFormat}`);
  return lines.join("\n");
}

/**
 * 预填正文的新建 Issue 地址：环境块在最前，后面接调用方给的段落标题。
 * 正文里的换行与中文全部走 encodeURIComponent，否则拼出来的 URL 一贴到聊天窗就断。
 */
export function buildNewIssueURL(envBlock: string, sections: string[]): string {
  const body = [envBlock, "", ...sections.filter((s) => s.trim() !== "")].join("\n");
  return `${FEEDBACK_REPO_URL}/issues/new?body=${encodeURIComponent(body)}`;
}
