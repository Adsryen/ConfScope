import { useEffect, useRef, useState } from "react";

export interface Option {
  value: string;
  label: string;
}

interface Props {
  value: string;
  options: Option[];
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  title?: string;
  className?: string;
}

/** 自绘下拉框：与深色主题一致，替代原生 select（原生弹层样式跟随系统、与主题不符）。 */
export default function Select({
  value,
  options,
  onChange,
  disabled,
  placeholder,
  title,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cur = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`sel${className ? " " + className : ""}`} ref={ref} title={title}>
      <button
        type="button"
        className="sel-trigger"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`sel-value${cur ? "" : " placeholder"}`}>
          {cur?.label ?? placeholder ?? ""}
        </span>
        <span className="sel-arrow">▾</span>
      </button>
      {open && (
        <div className="sel-menu">
          {options.map((o) => (
            <div
              key={o.value}
              className={`sel-option${o.value === value ? " active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault(); // 抢在 window mousedown(外部关闭)之前完成选中
                e.stopPropagation();
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
