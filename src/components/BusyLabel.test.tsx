/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "../test/react";
import BusyLabel from "./BusyLabel";

/**
 * BusyLabel 的两条既有约定（轮74 A3）：
 * 1. 两档文案都留在 DOM 里（宽度由较宽的一档决定，切换文案时盒子不跳）；
 * 2. 但此刻只有可见那一档进可访问名——否则读屏会把「清理缓存 清理中...」两个状态名一起念。
 * 宽度本身只能在真机量（jsdom 一律给 0），由 tests/retest/specs/99-s-busy-label-no-jump.spec.ts 盯；
 * 这里盯的是 DOM 结构与可访问名。
 */
const options = (stack: Element) => Array.from(stack.querySelectorAll<HTMLElement>(".busy-label-option"));

describe("BusyLabel", () => {
  it("静息态：两档都在，只有静息那档可见且可被念到", () => {
    render(
      <button>
        <BusyLabel busy={false} idle="清理缓存" busyText="清理中..." />
      </button>
    );
    const stack = document.querySelector(".busy-label-stack") as Element;
    expect(options(stack).map((el) => el.textContent)).toEqual(["清理缓存", "清理中..."]);
    expect(options(stack).map((el) => el.getAttribute("data-shown"))).toEqual(["true", "false"]);
    expect(screen.getByRole("button", { name: "清理缓存" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /清理中/ })).not.toBeInTheDocument();
    // WCAG 2.5.3：可见文字必须含在可访问名里
    expect(screen.getByRole("button").textContent).toContain("清理缓存");
  });

  it("忙态：换成忙态文案，静息那档只占位不被念", () => {
    render(
      <button>
        <BusyLabel busy idle="清理缓存" busyText="清理中..." />
      </button>
    );
    const stack = document.querySelector(".busy-label-stack") as Element;
    expect(options(stack).map((el) => el.getAttribute("data-shown"))).toEqual(["false", "true"]);
    expect(options(stack).map((el) => el.getAttribute("aria-hidden"))).toEqual(["true", null]);
    expect(screen.getByRole("button", { name: "清理中..." })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "清理缓存" })).not.toBeInTheDocument();
  });
});
