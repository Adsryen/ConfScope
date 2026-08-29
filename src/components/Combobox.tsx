import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ComboOption {
  value: string;
  /** 可选的分组或辅助说明文案。 */
  sub?: string;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** 选中候选项时回传完整 option，便于同步 group 等字段。 */
  onPick?: (o: ComboOption) => void;
  options: ComboOption[];
  placeholder?: string;
  disabled?: boolean;
}

/** 模糊匹配：子串命中或字符顺序命中。
 * 注意：当前值(value)作为查询时不能把候选"过滤没"——
 * 否则 group/dataId 这类"值=当前选中项"的 combobox 展开后只剩自身一项，
 * 用户无法看到/切换到其他候选（真人操作下表现为下拉候选不全）。
 * 候选项与当前值完全相同时视为命中。 */
function fuzzy(query: string, text: string, exactValue?: string): boolean {
  if (!query) return true;
  if (exactValue !== undefined && text === exactValue) return true;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  let i = 0;
  for (let k = 0; k < t.length && i < q.length; k++) {
    if (t[k] === q[i]) i++;
  }
  return i === q.length;
}

/** 输入框 + 候选下拉框（combobox）：支持模糊过滤，并防止被父容器裁剪。 */
export default function Combobox({ value, onChange, onPick, options, placeholder, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const filtered = options.filter((o) => fuzzy(value, o.value, value) || (o.sub ? fuzzy(value, o.sub) : false)).slice(0, 50);

  const updateMenuPosition = useCallback(() => {
    const trigger = ref.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const desiredHeight = 260;
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
    if (!open || filtered.length === 0) return;
    updateMenuPosition();
  }, [filtered.length, open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onResize = () => updateMenuPosition();
    window.addEventListener("pointerdown", onDoc);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("pointerdown", onDoc);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [open, updateMenuPosition]);

  return (
    <div className="combo" ref={ref}>
      <input
        className="search-input wide mono"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      />
      {open &&
        filtered.length > 0 &&
        createPortal(
          <div ref={menuRef} className="combo-menu combo-menu-portal" style={menuStyle}>
            {filtered.map((o, i) => (
              <div
                key={`${o.value}/${o.sub ?? ""}/${i}`}
                className={`combo-option${o.value === value ? " active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault(); // 防止 input 失焦抢先关闭下拉框
                  e.stopPropagation();
                  onChange(o.value);
                  onPick?.(o);
                  setOpen(false);
                }}
              >
                <span className="combo-val">{o.value}</span>
                {o.sub && <span className="combo-sub">{o.sub}</span>}
              </div>
            ))}
          </div>,
          document.body
        )}
    </div>
  );
}
