import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n";
import { copyText } from "../lib/clipboard";
import { toast } from "../lib/toast";

interface Props {
  text: string;
  label?: string;
  /**
   * 可访问名（aria-label）。可见文字一个字不动，只给读屏补「复制的是哪一份」。
   * 轮67 R67-WP5：数据位置 7 行的按钮可读名全是「复制」，键盘走到第 34 颗时
   * 听不出这是日志目录还是备份快照的复制——同一屏 7 个同名动作就是 WCAG 2.4.6 的缺陷。
   * 写法上按 WCAG 2.5.3 要求把可见文字含在名字里（见 locales 的 copyPathAria）。
   */
  ariaLabel?: string;
}

/** 复制按钮：点击复制 text，短暂显示「已复制」反馈。 */
export default function CopyButton({ text, label, ariaLabel }: Props) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onClick = async () => {
    // 剪贴板在 WebView 里可能被权限拦掉，失败必须说一声——以前是点了没反应（轮6 R51）
    if (await copyText(text)) {
      setDone(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setDone(false), 1200);
      return;
    }
    toast(t("common.copyFailed"), "error");
  };

  return (
    <button className="btn btn-ghost btn-sm" onClick={onClick} disabled={!text} aria-label={ariaLabel} title={t("common.copyToClipboard")}>
      {done ? t("common.copied") : (label ?? t("common.copy"))}
    </button>
  );
}
