import { useEffect, useId, useRef, useState } from "react";

/**
 * 数字输入框（R24）：把「用户敲的文本」和「业务存的数值」分开管。
 *
 * 原生 `<input type="number">` 直接绑数值会踩三个坑（本仓库曾有 4 个副本各踩一遍）：
 * 1. 清空 → `parseInt("")` 是 NaN → `|| 默认值` 当场把数字弹回输入框，用户看不到自己删了什么；
 * 2. 输入 0 → 0 是 falsy → 被 `||` 吞成默认值；
 * 3. 越界（999999）照旧能存，直到连接失败才发现。
 *
 * 这里的约定：文本态留在组件内部（清空就显示清空），数值只在解析成功时回写；
 * 默认值等失焦才回弹；越界不静默夹取，而是由调用方注入的 `validate` 出行内错误、
 * 并由调用方禁用保存——同一条判据，不会出现界面说合法而保存又拦下。
 */
export interface NumberFieldProps {
  /** 业务侧数值；undefined 表示留空。 */
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  /** 失焦且留空时回弹的默认值；不传则保持空（可选字段）。 */
  fallback?: number;
  placeholder?: string;
  /** 值非法时返回可直接展示的文案，合法（含允许留空）返回 undefined。文案由调用方本地化。 */
  validate?: (value: number | undefined) => string | undefined;
  disabled?: boolean;
  /** 外层 label 已提供可见名称时可以不传；否则作为 aria-label 兜底。 */
  ariaLabel?: string;
}

/** 文本 → 数值：空串与非数字都算「没有值」，由 validate 决定留空是否合法。 */
function parseText(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const next = Number(trimmed);
  return Number.isFinite(next) ? next : undefined;
}

export default function NumberField({
  value,
  onChange,
  min,
  max,
  step,
  fallback,
  placeholder,
  validate,
  disabled,
  ariaLabel,
}: NumberFieldProps) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const [text, setText] = useState(() => (value === undefined ? "" : String(value)));
  const [hasBlurred, setHasBlurred] = useState(false);
  const focusedRef = useRef(false);

  // 只有外部把值改了（切档案、程序化回填）才对齐文本；用户正在敲的时候绝不动他的文本，
  // 否则「清空」这一步会被回弹的默认值当场吞掉——那正是 R24 要修的原始 bug。
  useEffect(() => {
    if (focusedRef.current) return;
    setText((prev) => {
      if (parseText(prev) === value) return prev;
      return value === undefined ? "" : String(value);
    });
  }, [value]);

  const parsed = parseText(text);
  const issue = validate ? validate(parsed) : undefined;
  // 必填项在用户还没离开输入框之前不提前报红：一边删字符一边闪红只会碍事。
  const showError = issue !== undefined && (parsed !== undefined || hasBlurred);

  return (
    <span className="number-field">
      <input
        id={inputId}
        className="field-input mono"
        type="number"
        inputMode="numeric"
        value={text}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={showError ? true : undefined}
        aria-describedby={showError ? errorId : undefined}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseText(e.target.value));
        }}
        onBlur={(e) => {
          focusedRef.current = false;
          setHasBlurred(true);
          const committed = parseText(e.target.value);
          // 留空 + 有默认值 → 失焦才回弹；留空 + 可选 → 就按留空交给业务
          if (committed === undefined && fallback !== undefined) {
            setText(String(fallback));
            onChange(fallback);
            return;
          }
          onChange(committed);
          setText(committed === undefined ? "" : String(committed));
        }}
        // 滚轮路过就顺手改端口值：这里选「立刻失焦」而不是 onWheel 里 preventDefault()。
        // 原因写死在这：React 把 wheel 当 passive 监听器挂在根节点上，合成事件里调用
        // preventDefault() 根本不生效（还会刷一条 console warning，违反仓库禁用 console 的约定）；
        // 而原生 number input 只有在「聚焦」时才会被滚轮改值，先 blur 就赶在默认动作之前切断了这条路。
        onWheel={(e) => e.currentTarget.blur()}
      />
      {showError && (
        <span className="field-error" id={errorId} role="alert">
          {issue}
        </span>
      )}
    </span>
  );
}
