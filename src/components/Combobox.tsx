import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ComboOption {
  value: string;
  /** ?????? group?????????? */
  sub?: string;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** ????????????????? option????? group ??? */
  onPick?: (o: ComboOption) => void;
  options: ComboOption[];
  placeholder?: string;
  disabled?: boolean;
}

/** ????:?????(????????),??????? */
function fuzzy(query: string, text: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  let i = 0;
  for (let k = 0; k < t.length && i < q.length; k++) {
    if (t[k] === q[i]) i++;
  }
  return i === q.length;
}

/** ??? + ??????(combobox):??????,??????? */
export default function Combobox({ value, onChange, onPick, options, placeholder, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const filtered = options
    .filter((o) => fuzzy(value, o.value) || (o.sub ? fuzzy(value, o.sub) : false))
    .slice(0, 50);

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
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onResize = () => updateMenuPosition();
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("mousedown", onDoc);
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
                  e.preventDefault(); // ?? input ?????????
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
