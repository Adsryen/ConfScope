import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const cur = options.find((o) => o.value === value);

  const updateMenuPosition = useCallback(() => {
    const trigger = ref.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const desiredHeight = 280;
    const openAbove = spaceBelow < 160 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, Math.min(desiredHeight, openAbove ? spaceAbove : spaceBelow));
    const top = openAbove ? Math.max(8, rect.top - 4 - maxHeight) : rect.bottom + 4;
    setMenuStyle({
      position: "fixed",
      top,
      left: rect.left,
      right: "auto",
      width: rect.width,
      maxHeight,
      zIndex: 10000,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updateMenuPosition();
  }, [open, options.length, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onResize = () => updateMenuPosition();
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [open, updateMenuPosition]);

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
      {open &&
        createPortal(
          <div ref={menuRef} className="sel-menu sel-menu-portal" style={menuStyle}>
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
          </div>,
          document.body
        )}
    </div>
  );
}
