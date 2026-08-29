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
  // 标记最近一次"由触发器自身 pointerdown 打开"，用于 click 兜底去重
  // （同一物理点击会先触发 pointerdown 再触发 click，两者都 toggle 会闪开即关）。
  const openedByTrigger = useRef(false);
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
    const onDoc = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onResize = () => updateMenuPosition();
    window.addEventListener("pointerdown", onDoc);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("pointerdown", onDoc);
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
        onPointerDown={(e) => {
          // 用 pointerdown 而非 click 开菜单：click 会先触发 window pointerdown 监听，
          // 触发器自身在 ref 外时（如点击边框 1px 处）会被误判为"外部点击"立即关闭，
          // 菜单闪开即关，用户/自动化都看不到选项（对比页"来源"下拉实测）。
          e.stopPropagation();
          openedByTrigger.current = true;
          setOpen((o) => !o);
        }}
        onClick={(e) => {
          // 兜底：纯 mouse 事件的点击器（部分自动化驱动/触屏合成点击）不触发
          // PointerEvent 的 onPointerDown，此时用 click 开菜单；同一物理点击
          // 已由 pointerdown 处理过（openedByTrigger）则跳过，避免 toggle 两次。
          if (openedByTrigger.current) {
            openedByTrigger.current = false;
            return;
          }
          e.stopPropagation();
          setOpen((o) => !o);
        }}
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
