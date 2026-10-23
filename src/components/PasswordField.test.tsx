/**
 * @vitest-environment jsdom
 */
import { useState, type ReactNode } from "react";
import { fireEvent, render, screen } from "../test/react";
import { beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import PasswordField, { type PasswordFieldProps } from "./PasswordField";

/**
 * 为什么组件用例要自己算一遍可访问名（而不是全靠真机）：
 * jsdom 里 `getByRole("textbox")` 不认 `type="password"`（aria-query 没给这类 input 隐式角色），
 * 所以先点成可见文本再按 role+name 取——可访问名的算法与 type 无关，翻转后量到的就是同一份名字。
 */
function renderField(props: Partial<PasswordFieldProps> = {}, children?: ReactNode) {
  return render(
    <I18nProvider>
      <div>
        <PasswordField label="Nacos 密码" name="probe-password" autoComplete="current-password" value="" onChange={() => {}} {...props} />
        {children}
      </div>
    </I18nProvider>
  );
}

const probe = () => document.querySelector<HTMLInputElement>('input[name="probe-password"]') as HTMLInputElement;

/** 受控外壳：断言「组件回写的是字符串」而不是事件对象。 */
function Controlled() {
  const [value, setValue] = useState("");
  return (
    <div>
      <PasswordField label="Nacos 密码" name="probe-password" autoComplete="current-password" value={value} onChange={setValue} />
      <output>{value || "<空>"}</output>
    </div>
  );
}

beforeEach(() => {
  localStorage.setItem("locale", "zh-CN");
});

describe("PasswordField 语义（轮67 R67-WP6）", () => {
  it("默认遮住，自动填充与拼写检查语义都落在 DOM 上", () => {
    renderField();
    const input = probe();

    expect(input.type).toBe("password");
    expect(input).toHaveAttribute("name", "probe-password");
    expect(input).toHaveAttribute("autocomplete", "current-password");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAttribute("autocapitalize", "off");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input.getAttribute("aria-labelledby")).toBeTruthy();
  });

  it("可访问名恰好是标题，不带上那颗回显按钮", () => {
    renderField();
    const input = probe();
    // 按钮和输入框同在一只 <label> 里，label 的 textContent 确实带上了按钮字形——
    // 这条是「不显式 aria-labelledby 就会被并进名字」的前提，前提在而名字仍干净才算修好。
    expect(input.closest("label")?.textContent).toContain("👁");
    expect(document.querySelector(`#${CSS.escape(input.getAttribute("aria-labelledby") as string)}`)?.textContent).toBe("Nacos 密码");

    fireEvent.click(screen.getByRole("button", { name: "显示密码" }));
    expect(input.type).toBe("text");
    // getByRole 传字符串 name 本来就是全等匹配（exact 是 getByLabelText 那套的选项）
    expect(screen.getAllByRole("textbox", { name: "Nacos 密码" })).toEqual([input]);
  });

  it("点开关翻转遮显，aria-pressed 跟着说真话", () => {
    renderField();
    const input = probe();
    const toggle = screen.getByRole("button", { name: "显示密码" });

    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(input.type).toBe("text");
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(toggle);
    expect(input.type).toBe("password");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("按下开关时阻止默认，焦点才不会被按钮抢走", () => {
    renderField();
    const toggle = screen.getByRole("button", { name: "显示密码" });
    // fireEvent 在 preventDefault 被调用时返回 false。jsdom 侧只能验到这个口径，
    // 「点完焦点仍在输入框」由真机回归 99-s-password-fields-semantics 量 document.activeElement。
    expect(fireEvent.mouseDown(toggle)).toBe(false);
  });

  it("每框各持一颗开关，点一个不许把同屏其他框一起显出来", () => {
    renderField(
      { label: "Apollo Token", name: "probe-a" },
      <PasswordField label="Consul Token" name="probe-b" autoComplete="off" value="" onChange={() => {}} />
    );
    const first = document.querySelector<HTMLInputElement>('input[name="probe-a"]') as HTMLInputElement;
    const second = document.querySelector<HTMLInputElement>('input[name="probe-b"]') as HTMLInputElement;

    fireEvent.click(screen.getAllByRole("button", { name: "显示密码" })[0]);

    expect(first.type).toBe("text");
    expect(second.type).toBe("password");
  });

  it("onChange 收到的是字符串，输入能落回调用方", () => {
    render(<I18nProvider><Controlled /></I18nProvider>);
    fireEvent.change(probe(), { target: { value: "s3cret" } });
    expect(screen.getByText("s3cret")).toBeInTheDocument();
  });

  it("className / labelClassName / disabled / placeholder 传给该传的元素", () => {
    renderField({ className: "search-input wide mono", labelClassName: "backup-webdav-package-password", disabled: true, placeholder: "留空则不修改" });
    const input = probe();

    expect(input.className).toBe("search-input wide mono");
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("placeholder", "留空则不修改");
    expect(input.closest("label")).toHaveClass("field", "backup-webdav-package-password");
  });
});
