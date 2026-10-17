/**
 * @vitest-environment jsdom
 */
import { useState } from "react";
import { fireEvent, render, screen } from "../test/react";
import { beforeEach, describe, expect, it } from "vitest";
import NumberField, { type NumberFieldProps } from "./NumberField";
import { PORT_MAX, PORT_MIN, SSH_DEFAULT_PORT, portIssue } from "../lib/ports";

/**
 * 受控外壳：把组件回写的值显示在 <output> 上，这样「文本态」和「数值态」能分别断言——
 * R24 的坑正是这两者被混成一个（清空即弹回、0 被当 falsy 吞掉）。
 */
function Controlled({
  defaultValue = SSH_DEFAULT_PORT,
  externalValue,
  ...props
}: Partial<NumberFieldProps> & { defaultValue?: number; externalValue?: number }) {
  const [value, setValue] = useState<number | undefined>(defaultValue);
  return (
    <label className="field">
      <span>SSH 端口</span>
      <NumberField {...props} value={externalValue ?? value} onChange={setValue} />
      <output>{value === undefined ? "<空>" : String(value)}</output>
      <button type="button" onClick={() => setValue(8080)}>
        外部回填
      </button>
    </label>
  );
}

const portValidate = (next: number | undefined) => portIssue(next, { label: "SSH 端口" });

beforeEach(() => {
  localStorage.setItem("locale", "zh-CN");
});

describe("NumberField 文本态与数值态分离（R24）", () => {
  it("清空时输入框保持空，不被默认值当场弹回", () => {
    render(<Controlled validate={portValidate} fallback={SSH_DEFAULT_PORT} />);
    const input = screen.getByRole<HTMLInputElement>("spinbutton");

    fireEvent.change(input, { target: { value: "" } });

    expect(input.value).toBe(""); // 文本态
    expect(screen.getByText("<空>")).toBeInTheDocument();
  });

  it("失焦才回弹默认端口", () => {
    render(<Controlled validate={portValidate} fallback={SSH_DEFAULT_PORT} />);
    const input = screen.getByRole<HTMLInputElement>("spinbutton");

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    expect(input.value).toBe("22"); // 文本态
    expect(screen.getByText("22")).toBeInTheDocument();
  });

  it("没配 fallback 的可选字段，失焦后仍然是空", () => {
    render(<Controlled validate={(next) => portIssue(next, { label: "本地端口", optional: true })} />);
    const input = screen.getByRole<HTMLInputElement>("spinbutton");

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    expect(input.value).toBe(""); // 文本态
    expect(screen.getByText("<空>")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("输入 0 保留 0：不再被 parseInt(...) || 默认值 当 falsy 吞掉，同时报越界", () => {
    render(<Controlled validate={portValidate} fallback={SSH_DEFAULT_PORT} />);
    const input = screen.getByRole<HTMLInputElement>("spinbutton");

    fireEvent.change(input, { target: { value: "0" } });

    expect(screen.getByText("0")).toBeInTheDocument(); // 数值态确实是 0，没有被改写成 22
    expect(screen.getByRole("alert")).toHaveTextContent("SSH 端口需在 1–65535 之间（当前 0）");
  });

  it("越界值照样回写给业务，让调用方能禁用保存，同时出行内错误", () => {
    render(<Controlled validate={portValidate} min={PORT_MIN} max={PORT_MAX} />);
    const input = screen.getByRole<HTMLInputElement>("spinbutton");

    fireEvent.change(input, { target: { value: "999999" } });

    expect(screen.getByText("999999")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("SSH 端口需在 1–65535 之间（当前 999999）");
  });

  it("不夹取、不改写：越界时输入框里的数字仍是用户敲的那串", () => {
    render(<Controlled validate={portValidate} min={PORT_MIN} max={PORT_MAX} />);
    const input = screen.getByRole<HTMLInputElement>("spinbutton");

    fireEvent.change(input, { target: { value: "999999" } });
    fireEvent.blur(input);

    expect(input.value).toBe("999999"); // 文本态
  });

  it("必填字段留空时，敲字过程中不报红，失焦后才解释", () => {
    render(<Controlled validate={portValidate} min={PORT_MIN} max={PORT_MAX} />);
    const input = screen.getByRole<HTMLInputElement>("spinbutton");

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.blur(input);
    expect(screen.getByRole("alert")).toHaveTextContent("SSH 端口不能为空");
  });

  it("合法值不带任何错误提示，也不占用 aria-describedby", () => {
    render(<Controlled validate={portValidate} />);
    const input = screen.getByRole<HTMLInputElement>("spinbutton");

    fireEvent.change(input, { target: { value: "2222" } });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("失焦把 0022 这类写法规范成 22，同时数值与文本一致", () => {
    render(<Controlled validate={portValidate} defaultValue={undefined} />);
    const input = screen.getByRole<HTMLInputElement>("spinbutton");

    fireEvent.change(input, { target: { value: "0022" } });
    fireEvent.blur(input);

    expect(input.value).toBe("22"); // 文本态
    expect(screen.getByText("22")).toBeInTheDocument();
  });
});

describe("NumberField 与外部值的同步（R24）", () => {
  it("未聚焦时外部回填会同步到文本", () => {
    render(<Controlled validate={portValidate} />);

    fireEvent.click(screen.getByRole("button", { name: "外部回填" }));

    expect(screen.getByRole<HTMLInputElement>("spinbutton").value).toBe("8080");
  });

  it("正在敲字时外部值不能抢走用户的文本与光标", () => {
    render(<Controlled validate={portValidate} />);
    const input = screen.getByRole<HTMLInputElement>("spinbutton");
    input.focus();

    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "外部回填" }));

    expect(input.value).toBe("1"); // 文本态
  });
});

describe("NumberField 滚轮防误改（R24）", () => {
  it("滚轮经过输入框时先失焦，值不变", () => {
    render(<Controlled validate={portValidate} />);
    const input = screen.getByRole<HTMLInputElement>("spinbutton");
    input.focus();
    expect(document.activeElement).toBe(input);

    fireEvent.wheel(input, { deltaY: 1 });

    expect(document.activeElement).not.toBe(input);
    expect(input.value).toBe("22"); // 文本态
    expect(screen.getByText("22")).toBeInTheDocument();
  });
});
