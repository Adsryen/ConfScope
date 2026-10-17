import { type CSSProperties, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { subscribeClosePopovers } from "../lib/popoverBus";
import { EscapePriority, isImeComposing, useEscape } from "../lib/useEscape";

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
  // 键盘/悬停高亮项索引；与"已选中"(value)分开，避免键盘导航覆盖选中语义
  const [activeIndex, setActiveIndex] = useState(-1);
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;
  // 首字母跳转：500ms 内连续按键累加成前缀，避免长名称只能按首字母循环
  const typeaheadRef = useRef({ buf: "", at: 0 });
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

  // 菜单展开时 Esc 只收菜单，不吃掉外层弹层的关闭（分层注册表按 dropdown 优先级胜出）。
  useEscape(open, () => setOpen(false), EscapePriority.dropdown);

  // 宿主页面被保活隐藏（模式切换）时收起菜单：portal 在 document.body 上，不随容器 hidden 消失。
  useEffect(() => subscribeClosePopovers(() => setOpen(false)), []);

  const toggleMenu = () => {
    if (open) setOpen(false);
    else openMenu();
  };

  const pick = (o: Option) => {
    onChange(o.value);
    setOpen(false);
  };

  // ↑↓ 移动高亮（到边界停住），未高亮时从首/尾开始
  const moveActive = (delta: number) => {
    if (options.length === 0) return;
    setActiveIndex((cur) => {
      const base = cur < 0 ? (delta > 0 ? -1 : options.length) : cur;
      return Math.min(options.length - 1, Math.max(0, base + delta));
    });
  };

  // 展开即把高亮定位到当前选中项：由展开动作显式调用，
  // 不放进依赖 options/value 的 effect —— 否则父组件每次重渲染都会把键盘导航的高亮重置掉。
  const openMenu = () => {
    const exact = options.findIndex((o) => o.value === value);
    setActiveIndex(exact >= 0 ? exact : options.length > 0 ? 0 : -1);
    setOpen(true);
  };

  // 收起后清掉高亮（外部点击/Esc/选中都走这里，无需各处重复）
  useEffect(() => {
    if (!open) setActiveIndex(-1);
  }, [open]);

  // 高亮项滚入弹层可视区（block:nearest 只动弹层，不让整页跳动）
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    menuRef.current?.querySelector(`[data-idx="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const typeahead = (ch: string) => {
    if (options.length === 0) return;
    const now = Date.now();
    const buf = now - typeaheadRef.current.at < 500 ? typeaheadRef.current.buf + ch : ch;
    typeaheadRef.current = { buf, at: now };
    const lower = buf.toLowerCase();
    const start = activeIndex < 0 ? 0 : (activeIndex + 1) % options.length;
    for (let step = 0; step < options.length; step++) {
      const i = (start + step) % options.length;
      if (options[i].label.toLowerCase().startsWith(lower)) {
        setActiveIndex(i);
        return;
      }
    }
  };

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
    <div className={`sel${className ? " " + className : ""}`} ref={ref} title={title ?? cur?.label ?? placeholder}>
      <button
        type="button"
        className="sel-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        onKeyDown={(e) => {
          // 菜单展开后焦点仍留在触发器（弹层不可聚焦），键盘事件在此统一处理
          if (disabled) return;
          // 组合态：Enter / Space / 方向键都属于 IME 候选操作，一律让路给输入法，
          // 否则「打字选候选」会被当成「选中当前项」或「首字母检索」
          if (isImeComposing(e)) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) openMenu();
            else moveActive(e.key === "ArrowDown" ? 1 : -1);
            return;
          }
          if (e.key === "Home" || e.key === "End") {
            if (!open) return; // 收起态把光标键交还页面
            e.preventDefault();
            setActiveIndex(e.key === "Home" ? 0 : options.length - 1);
            return;
          }
          if (e.key === "Enter" || e.key === " ") {
            if (!open) return; // 收起态走原生 click，Enter/Space 负责展开
            e.preventDefault(); // 阻止默认 click 再把菜单 toggle 一次
            const target = options[activeIndex];
            if (target) pick(target);
            else setOpen(false);
            return;
          }
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if (!open) {
              openMenu();
              return;
            }
            e.preventDefault();
            typeahead(e.key);
          }
        }}
        onPointerDown={(e) => {
          // 用 pointerdown 而非 click 开菜单：click 会先触发 window pointerdown 监听，
          // 触发器自身在 ref 外时（如点击边框 1px 处）会被误判为"外部点击"立即关闭，
          // 菜单闪开即关，用户/自动化都看不到选项（对比页"来源"下拉实测）。
          e.stopPropagation();
          openedByTrigger.current = true;
          toggleMenu();
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
          toggleMenu();
        }}
      >
        <span className={`sel-value${cur ? "" : " placeholder"}`}>
          {cur?.label ?? placeholder ?? ""}
        </span>
        <span className="sel-arrow">▾</span>
      </button>
      {open &&
        createPortal(
          <div ref={menuRef} id={listId} role="listbox" className="sel-menu sel-menu-portal" style={menuStyle}>
            {options.map((o, i) => (
              <div
                key={o.value}
                id={optionId(i)}
                data-idx={i}
                role="option"
                aria-selected={o.value === value}
                className={`sel-option${o.value === value ? " active" : ""}${i === activeIndex ? " highlighted" : ""}`}
                onMouseEnter={() => setActiveIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault(); // 抢在 window mousedown(外部关闭)之前完成选中
                  e.stopPropagation();
                  pick(o);
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
