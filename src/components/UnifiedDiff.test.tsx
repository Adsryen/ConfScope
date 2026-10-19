/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "../test/react";
import { beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import UnifiedDiff from "./UnifiedDiff";

function renderUnifiedDiff(props: Partial<Parameters<typeof UnifiedDiff>[0]> = {}, locale = "en-US") {
  localStorage.setItem("locale", locale);
  return render(
    <I18nProvider>
      <UnifiedDiff oldText={"server.port=8080\nfeature.enabled=false"} newText={"server.port=9090\nfeature.enabled=true"} {...props} />
    </I18nProvider>
  );
}

describe("UnifiedDiff", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("localizes diff stats and the only-changes toggle", () => {
    renderUnifiedDiff();

    expect(screen.getByText("+0 added")).toBeInTheDocument();
    expect(screen.getByText("-0 deleted")).toBeInTheDocument();
    expect(screen.getByText("~2 modified")).toBeInTheDocument();
    expect(screen.getByLabelText("Only show changes")).not.toBeChecked();

    fireEvent.click(screen.getByLabelText("Only show changes"));

    expect(screen.getByLabelText("Only show changes")).toBeChecked();
  });

  it("localizes the identical-state message", () => {
    renderUnifiedDiff({ oldText: "same=true", newText: "same=true" });

    expect(screen.getByText("No differences with previous version")).toBeInTheDocument();
  });

  // 轮41：历史变更的**默认**视图就是这块 diff，页面级正文搜索词必须跟到这里（R41-1）。
  // 缺陷长什么样（真机取证见 .trellis/tasks/10-19-10-19-ui-ux-41/prd.md）：改前 .diff-panel 内
  // mark.search-hit = 0 而行文本里确实有 enabled ⇒ 不是「这版没这个词」，是词压根没传进来。
  describe("页面级正文搜索词", () => {
    const diffTermProps = { format: "YAML" as const };

    it("传词时命中词标红、行号进入命中态（R41-1/R41-3）", () => {
      renderUnifiedDiff({ ...diffTermProps, searchTerm: "enabled" });

      const marks = document.querySelectorAll(".udiff-text mark.search-hit");
      expect(marks.length).toBeGreaterThan(0);
      // 命中的是 feature.enabled 那一对 del/add 行（fixture 里没有 ctx 行）
      expect(document.querySelectorAll(".udiff-gutter.is-hit").length).toBe(marks.length);
      for (const mark of Array.from(marks)) expect(mark.textContent).toBe("enabled");
    });

    it("标红不许破坏文本契约：每行剥标签后逐字等于原文", () => {
      const oldText = 'url: "http://a.com?x=1&y=2" # enabled\nkey: it\'s <b>&</b> enabled';
      const newText = 'url: "http://a.com?x=1&y=2" # enabled\nkey: it\'s <b>&</b> disabled';
      renderUnifiedDiff({ ...diffTermProps, oldText, newText, searchTerm: "enabled" });

      const texts = Array.from(document.querySelectorAll(".udiff-text")).map((el) => el.textContent ?? "");
      expect(texts.some((t) => t.includes("enabled"))).toBe(true);
      // 与原始行文本逐条对：& < > 不许二次转义（&amp;amp; 那类历史事故）
      expect(texts.filter((t) => t.includes("&amp;"))).toEqual([]);
      expect(texts.filter((t) => t.includes("<b>")).length).toBeGreaterThan(0);
    });

    it("口径中性：大小写不同的词照样标（与左侧列表同一口径）", () => {
      renderUnifiedDiff({ ...diffTermProps, searchTerm: "ENABLED" });
      expect(document.querySelectorAll(".udiff-text mark.search-hit").length).toBeGreaterThan(0);
    });

    it("不传词 / 纯空白词时一处都不标，行号也不进命中态（R41-4）", () => {
      for (const term of [undefined, "   "]) {
        const { unmount } = renderUnifiedDiff({ ...diffTermProps, searchTerm: term });
        expect(document.querySelectorAll(".udiff-text mark.search-hit").length).toBe(0);
        expect(document.querySelectorAll(".udiff-gutter.is-hit").length).toBe(0);
        // 文本仍在（不是「渲染空了才没有标」）
        const texts = Array.from(document.querySelectorAll(".udiff-text")).map((el) => el.textContent ?? "");
        expect(texts.some((line) => line.includes("enabled"))).toBe(true);
        unmount();
      }
    });

    it("TEXT 档（不高亮）同样标得到：只留一条渲染出口（R41-5）", () => {
      const { unmount } = renderUnifiedDiff({ format: "TEXT" as const, searchTerm: "enabled" });
      expect(document.querySelectorAll(".udiff-text mark.search-hit").length).toBeGreaterThan(0);
      unmount();

      // 不高亮时仍要正确转义：原文里的 <b> 不许变成真标签（原先这条分支交给 React 文本节点，
      // 现在与高亮分支共用一条管线，转义就必须自己守住）
      const raw = renderUnifiedDiff({
        format: "TEXT" as const,
        oldText: "a: <b>&</b> enabled",
        newText: "a: <c> disabled",
        searchTerm: "enabled",
      });
      const line = raw.container.querySelector(".udiff-text")!;
      expect(line.textContent).toBe("a: <b>&</b> enabled");
      expect(line.querySelector("b")).toBeNull();
      expect(line.querySelector("mark.search-hit")!.textContent).toBe("enabled");
    });

    it("勾选「仅显示变更」时只在可见行上标，不隐藏任何命中行以外的东西（R41-4）", () => {
      const oldText = "keep: enabled\nold: 1";
      const newText = "keep: enabled\nnew: 2";
      renderUnifiedDiff({ ...diffTermProps, oldText, newText, searchTerm: "enabled" });

      // 默认态：唯一命中落在 ctx 行上
      expect(document.querySelectorAll(".udiff-row.ctx").length).toBe(1);
      expect(document.querySelectorAll(".udiff-text mark.search-hit").length).toBe(1);
      expect(document.querySelectorAll(".udiff-gutter.is-hit").length).toBe(1);

      fireEvent.click(screen.getByLabelText("Only show changes"));

      // ctx 行被过滤掉 ⇒ 标记跟着可见行走，不许留下指向已消失行的红号
      expect(document.querySelectorAll(".udiff-row.ctx").length).toBe(0);
      expect(document.querySelectorAll(".udiff-text mark.search-hit").length).toBe(0);
      expect(document.querySelectorAll(".udiff-gutter.is-hit").length).toBe(0);
    });

    it("add / del 行的语义背景色不受搜索标记影响（R41-3 的 DOM 侧形状）", () => {
      renderUnifiedDiff({ ...diffTermProps, searchTerm: "enabled" });
      // 行本身不带搜索类：搜索色只落在 <mark> 与行号上，背景留给新增/删除语义
      expect(document.querySelectorAll(".udiff-row.is-hit").length).toBe(0);
      expect(document.querySelectorAll(".udiff-row.search-hit").length).toBe(0);
      const hitRow = document.querySelector(".udiff-gutter.is-hit")!.parentElement!;
      expect(hitRow.classList.contains("is-hit")).toBe(false);
      expect(hitRow.querySelector("mark.search-hit")).not.toBeNull();
    });
  });
});
