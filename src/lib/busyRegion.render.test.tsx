/**
 * @vitest-environment jsdom
 *
 * aria-busy 真的落到 DOM 上（轮15 波36 / R55）。
 *
 * busyProps 单测证的是纯函数，静态守卫证的是站点展开；两者都证不出 React 渲染以后
 * 「加载结束」那一次重渲染有没有把属性摘干净 —— 写成 "aria-busy": busy 就会留下
 * aria-busy="false"，读屏把静态区当常驻变动区继续盯。DOM 形态与各站点容器一致。
 */
import { render } from "../test/react";
import { describe, expect, it } from "vitest";
import { busyProps } from "./busyRegion";

function Region({ busy }: { busy: boolean }) {
  return (
    <div className="browser-items" {...busyProps(busy)}>
      <span className="region-body">rows</span>
    </div>
  );
}

function box(): HTMLElement {
  return document.querySelector(".browser-items") as HTMLElement;
}

describe("busyProps 渲染后的 DOM（波36 R55）", () => {
  it("异步换内容期间容器带上 aria-busy=true", () => {
    render(<Region busy />);
    expect(box()).toHaveAttribute("aria-busy", "true");
  });

  it("加载结束后属性被摘掉，而不是留下 aria-busy=false", () => {
    const view = render(<Region busy />);
    view.rerender(<Region busy={false} />);
    const el = box();
    expect(el).not.toHaveAttribute("aria-busy");
    expect(el.getAttribute("aria-busy")).toBeNull();
  });

  it("从头到尾没忙过的容器，DOM 上根本不存在这个属性", () => {
    render(<Region busy={false} />);
    expect(box()).not.toHaveAttribute("aria-busy");
  });

  it("busy 是附加属性，不改容器本身的 className", () => {
    render(<Region busy />);
    expect(box().className).toBe("browser-items");
  });
});
