import { useEffect, useState } from "react";
import { subscribe, ToastItem } from "../lib/toast";

/** 全局轻提示:右下角堆叠,自动消失。 */
export default function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => subscribe(setItems), []);
  return (
    <div className="toaster">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
