import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n";
import { copyText } from "../lib/clipboard";

interface Props {
  text: string;
  label?: string;
}

/** 复制按钮：点击复制 text，短暂显示「已复制」反馈。 */
export default function CopyButton({ text, label }: Props) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onClick = async () => {
    if (await copyText(text)) {
      setDone(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setDone(false), 1200);
    }
  };

  return (
    <button className="btn btn-ghost btn-sm" onClick={onClick} disabled={!text} title={t("common.copyToClipboard")}>
      {done ? t("common.copied") : (label ?? t("common.copy"))}
    </button>
  );
}
