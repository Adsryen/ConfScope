import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "../i18n";

export interface PasswordFieldProps {
  /**
   * 可见标题：纯文本，或 <FieldLabel/>（带必填星号与帮助符）。
   * 标题里只许有文字——按钮不能混进来，否则读屏念名字时会把动作一起念（见下方实现注释）。
   */
  label: ReactNode;
  value: string;
  /** 与 NumberField 同口径：组件自己拆出字符串，调用点只谈业务值。 */
  onChange: (next: string) => void;
  /** 自动填充配对的键名，必填且同屏唯一（浏览器靠它把「用户名+口令」成套认出来）。 */
  name: string;
  /** WHATWG 档位：新建口令 new-password、登录 current-password、既非填写也非登录（解密/令牌）off。 */
  autoComplete: "new-password" | "current-password" | "off";
  /** 输入框自身的类，默认 "search-input"；SSH/连接管理那边要传 "search-input wide mono"。 */
  className?: string;
  /** 外层 <label> 的附加类（如 BackupView 的跨列样式）。 */
  labelClassName?: string;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * 回显开关的图标（轮74 C1）。原先用 👁 / 🙈 两个彩色 emoji：设置页一行里因此出现
 * 26（emoji 撑高）/ 28（.btn.btn-sm）/ 29（输入框）三种高度，且 emoji 是彩色字形，
 * 与全站线性图标（NavIcon、.browser-tool-icon）不同族，Windows 与 macOS 还渲染成不同图案。
 * 换成同族的描边线性图标，两态共用一只眼睛，回显时多一条斜线。
 */
function RevealIcon({ shown }: { shown: boolean }) {
  const paths = [
    "M2.6 12S6.2 6.4 12 6.4 21.4 12 21.4 12 17.8 17.6 12 17.6 2.6 12 2.6 12Z",
    "M12 9.8a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Z",
  ];
  if (shown) paths.push("M4.6 4.6 19.4 19.4");
  return (
    <svg className="pwd-toggle-icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * 口令输入框（轮67 R67-WP6）：全站 18 处遮码框的唯一实现。
 *
 * 修前这三件事在 18 处各自漏一遍，且互相不一致：
 * 1. **可访问名被按钮污染**。回显开关和输入框同在一只 `<label>` 里，浏览器的 accname 算法
 *    会把 label 内所有子树文字并进输入框的名字。真机（Chromium）量连接管理那颗 Nacos 密码框
 *    拿到的是「密码 显示密码」，jsdom 侧同样算脏——读屏用户听完标题还得再听一遍按钮名，
 *    而 `getByLabel("密码", {exact:true})` 一个都取不到。唯一解是输入框显式 `aria-labelledby`
 *    指向只含标题文字的元素，把按钮彻底排除在名字来源之外。
 * 2. **没有 name / autocomplete**。浏览器无法把框和账号配对，密码管理器要么填错框、
 *    要么把新建加密口令的框当成登录口令回填。
 * 3. **没有回显开关**（设置页 8 处 + 备份 2 处 + SSH 2 处全是裸框）。敲错了自己看不见，
 *    只能靠「确认口令」那一框去猜；而连接管理 6 处有开关，却 4 处共用一颗 state，
 *    点一下同时显/隐 Apollo Token、Consul Token、密码、AK/SK——那不是用户要的形状。
 *
 * 状态自己持有（每框一颗开关），焦点靠 `onMouseDown preventDefault` 留在输入框
 * （FindBar 先例）：点完回显还能接着敲，不必再点一次框。
 * 开关的 `aria-label` 必须是静态的：带三元会和 `aria-pressed` 打架，播报成「隐藏，已按下」
 * 这种自相矛盾的话（守卫 toggleButtonsDeclareState 第三条用例把这条约定钉住）。
 */
export default function PasswordField({
  label,
  value,
  onChange,
  name,
  autoComplete,
  className,
  labelClassName,
  placeholder,
  disabled,
}: PasswordFieldProps) {
  const { t } = useTranslation();
  const captionId = useId();
  const [shown, setShown] = useState(false);

  return (
    <label className={`field${labelClassName ? ` ${labelClassName}` : ""}`}>
      <span id={captionId}>{label}</span>
      <span className="pwd-field">
        <input
          className={className ?? "search-input"}
          type={shown ? "text" : "password"}
          value={value}
          name={name}
          autoComplete={autoComplete}
          aria-labelledby={captionId}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="pwd-toggle"
          aria-label={t("common.revealPassword")}
          title={shown ? t("common.hidePassword") : t("common.revealPassword")}
          aria-pressed={shown}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShown((v) => !v)}
        >
          <RevealIcon shown={shown} />
        </button>
      </span>
    </label>
  );
}
