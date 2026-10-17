/**
 * @vitest-environment jsdom
 *
 * 收起查找条后，焦点必须回到「被查找的那一层」（轮16 波38 / R62）。
 *
 * 真 bug：CodeView 的 closeFind 只 setFindOpen(false)，查找输入框随卸载一起消失，activeElement 掉回 body。
 * 于是搜完按 Esc（或点 ✕）后接着按方向键 / PageUp / PageDown，代码一动不动，必须先拿鼠标点一下正文。
 * 同族的 CodeEditor 早就写了 taRef.current?.focus()，注释还写着「用户不用重新点一下才能继续打字」——
 * 两条出口口径不一致，说明这是漏接而不是设计。
 */
import { fireEvent, render } from "../test/react";
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { useState } from "react";
import { I18nProvider } from "../i18n";
import CodeEditor from "./CodeEditor";
import CodeView from "./CodeView";

const MULTI = 'server.port=8080\nname = "a<b&c>"\nqps: 10000\nport = 8081\n';
const OTHER = 'server.port=9090\nother = "x"\n';

function withI18n(node: ReactNode) {
  localStorage.setItem("locale", "zh-CN");
  return render(<I18nProvider>{node}</I18nProvider>);
}

function findInput(container: HTMLElement) {
  return container.querySelector(".code-find-input") as HTMLInputElement | null;
}

function closeButton(container: HTMLElement) {
  return container.querySelector('button[aria-label="关闭查找"]') as HTMLButtonElement | null;
}

function codeArea(container: HTMLElement) {
  return container.querySelector(".code-area") as HTMLElement;
}

describe("浏览态收起查找条把焦点还给正文区（波38 R62）", () => {
  it("Esc 收起后焦点在滚动容器上，且这一层就是键盘可达的那一层", () => {
    const { container } = withI18n(<CodeView code={MULTI} format="Properties" />);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(findInput(container)).not.toBeNull();
    fireEvent.keyDown(findInput(container) as HTMLInputElement, { key: "Escape" });

    expect(findInput(container)).toBeNull();
    const area = codeArea(container);
    expect(document.activeElement, "焦点掉回 body：方向键 / PageDown 不再滚这份代码").toBe(area);
    // 归还目标必须是「可滚动 + 可 Tab 到达」的那一层；换成 tabIndex=-1 的根节点等于没还。
    expect(area.getAttribute("tabindex")).toBe("0");
    expect(area.getAttribute("role")).toBe("region");
  });

  it("零命中时点 ✕ 也一样归还：搜不到更要把键盘留在正文里继续翻", () => {
    const { container } = withI18n(<CodeView code={MULTI} format="Properties" />);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = findInput(container) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "zzz-bufu" } });
    expect((container.querySelector(".code-find-count") as HTMLElement).textContent).toContain("无匹配");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(findInput(container)).toBeNull();
    expect(document.activeElement).toBe(codeArea(container));
  });

  it("点 ✕ 收起后同样把焦点还给正文区", () => {
    const { container } = withI18n(<CodeView code={MULTI} format="Properties" />);

    fireEvent.click(container.querySelector(".code-find-open") as HTMLElement);
    expect(findInput(container)).not.toBeNull();
    fireEvent.click(closeButton(container) as HTMLButtonElement);

    expect(findInput(container)).toBeNull();
    expect(document.activeElement).toBe(codeArea(container));
  });

  it("换文件收起查找栏时不许抢焦点：用户点的是左侧列表，焦点该留在他点的地方", () => {
    function Switcher() {
      const [code, setCode] = useState(MULTI);
      return (
        <>
          <button type="button" onClick={() => setCode(OTHER)}>
            换文件
          </button>
          <CodeView code={code} format="Properties" />
        </>
      );
    }
    const { container } = withI18n(<Switcher />);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = findInput(container) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "port" } });

    const switchBtn = container.querySelector("button") as HTMLButtonElement;
    switchBtn.focus();
    fireEvent.click(switchBtn);

    expect(findInput(container), "换文件确实要收起旧查找栏").toBeNull();
    expect(document.activeElement, "换文件不是「查找结束」，程序化把焦点拽进正文区会打断列表键盘导航").toBe(switchBtn);
  });

  it("组合态的 Esc 交回输入法：查找栏还在输入时不许出现程序化抢焦点", () => {
    const { container } = withI18n(<CodeView code={MULTI} format="Properties" />);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = findInput(container) as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });

    expect(findInput(container)).not.toBeNull();
    expect(document.activeElement, "输入法还在收候选，页面不该半路把焦点抢走").toBe(input);
  });
});

describe("编辑态收起查找条把焦点还给 textarea（与浏览态口径一致）", () => {
  it("Ctrl+F 开栏后 Esc 归还 textarea", () => {
    const { container } = withI18n(<CodeEditor value={MULTI} onChange={() => {}} format="Properties" />);
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;

    fireEvent.keyDown(ta, { key: "f", ctrlKey: true });
    fireEvent.keyDown(findInput(container) as HTMLInputElement, { key: "Escape" });

    expect(findInput(container)).toBeNull();
    expect(document.activeElement).toBe(ta);
  });

  it("点 ✕ 归还 textarea（两条出口同一个函数）", () => {
    const { container } = withI18n(<CodeEditor value={MULTI} onChange={() => {}} format="Properties" />);
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;

    fireEvent.keyDown(ta, { key: "f", ctrlKey: true });
    fireEvent.click(closeButton(container) as HTMLButtonElement);

    expect(findInput(container)).toBeNull();
    expect(document.activeElement).toBe(ta);
  });
});
