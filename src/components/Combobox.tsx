import { useEffect, useRef, useState } from "react";

export interface ComboOption {
  value: string;
  /** 次要说明（如 group），用于展示与匹配。 */
  sub?: string;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** 从下拉中选中某项时触发（可拿到完整 option，用于联动 group 等）。 */
  onPick?: (o: ComboOption) => void;
  options: ComboOption[];
  placeholder?: string;
  disabled?: boolean;
}

/** 模糊匹配:子序列匹配(字符按序出现即可),子串命中优先。 */
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

/** 可输入 + 模糊匹配下拉(combobox):既能从列表选,也能自由输入。 */
export default function Combobox({ value, onChange, onPick, options, placeholder, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const filtered = options
    .filter((o) => fuzzy(value, o.value) || (o.sub ? fuzzy(value, o.sub) : false))
    .slice(0, 50);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    return () => window.removeEventListener("mousedown", onDoc);
  }, [open]);

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
      {open && filtered.length > 0 && (
        <div className="combo-menu">
          {filtered.map((o, i) => (
            <div
              key={`${o.value}/${o.sub ?? ""}/${i}`}
              className={`combo-option${o.value === value ? " active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault(); // 避免 input 先失焦导致点击丢失
                onChange(o.value);
                onPick?.(o);
                setOpen(false);
              }}
            >
              <span className="combo-val">{o.value}</span>
              {o.sub && <span className="combo-sub">{o.sub}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
