import { useEffect, useState } from "react";
import { useTranslation } from "../i18n";
import { dismiss, hold, release, subscribe, ToastItem } from "../lib/toast";

/**
 * 全局轻提示：顶部居中堆叠，自动消失但可干预（R25）。
 *
 * - 容器常驻且 aria-live="polite"：活区必须在内容插入前就存在，读屏才播报得到；
 *   内容再按类型细分——error 用 role="alert" 立刻打断，其余 role="status" 排队播报；
 * - 悬停或键盘聚焦时暂停倒计时（lib/toast 的 hold/release），移开后再补一段短尾巴；
 * - 每条都能手动关闭，文本用独立节点承载，选中复制不会被关闭按钮抢走；
 * - 同文案合并后以「× N」显示，连报错不再刷屏。
 */
export default function Toaster() {
  const { t } = useTranslation();
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => subscribe(setItems), []);

  const closeLabel = t("common.close");

  return (
    <div className="toaster" role="region" aria-label={t("toast.stackLabel")} aria-live="polite" aria-atomic="false">
      {items.map((item) => (
        <div
          key={item.id}
          className={`toast toast-${item.type}`}
          role={item.type === "error" ? "alert" : "status"}
          onMouseEnter={() => hold(item.id)}
          onMouseLeave={() => release(item.id)}
          onFocus={() => hold(item.id)}
          onBlur={() => release(item.id)}
        >
          <span className="toast-text">{item.text}</span>
          {item.count > 1 && <span className="toast-count">× {item.count}</span>}
          <button type="button" className="toast-close" title={closeLabel} aria-label={closeLabel} onClick={() => dismiss(item.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
