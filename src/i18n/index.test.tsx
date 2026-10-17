/**
 * @vitest-environment jsdom
 */
/**
 * 组件侧 `t(key, params)` 的插值行为（轮14 波31 / R52）。
 *
 * 这里只验一件事：把用户输入原样回显的文案，值里的 `$` 序列必须逐字出现在界面上。
 * 修之前 `t("config.contentSearchEmpty", { term: "a$&b" })` 会渲染成
 * 「内容搜索没有命中「a{term}b}」——`$&` 被展开成命中的占位符本身，用户搜的词一个字没显示，
 * 还漏出内部占位符名。静态守卫在 tests/ux/i18nInterpolationSingleSource.test.ts。
 */
import { render, screen } from "../test/react";
import { describe, expect, it } from "vitest";
import { I18nProvider, useTranslation } from "../i18n";

function Echo({ term }: { term: string }) {
  const { t } = useTranslation();
  return <div data-testid="echo">{t("config.contentSearchEmpty", { term })}</div>;
}

function renderEcho(term: string, locale: "zh-CN" | "en-US") {
  localStorage.setItem("locale", locale);
  return render(
    <I18nProvider>
      <Echo term={term} />
    </I18nProvider>
  );
}

function echoText(term: string, locale: "zh-CN" | "en-US" = "zh-CN"): string {
  const view = renderEcho(term, locale);
  const text = screen.getByTestId("echo").textContent ?? "";
  view.unmount();
  return text;
}

describe("组件 t() 的参数插值", () => {
  it("$& 原样回显，不展开成占位符本身", () => {
    expect(echoText("a$&b")).toBe("内容搜索没有命中「a$&b」");
  });

  it("$` 与 $' 与 $1 与 $$ 同样逐字保留", () => {
    for (const term of ["a$`b", "a$b", "a$1b", "a$$b", "$&"]) {
      expect(echoText(term)).toBe("内容搜索没有命中「" + term + "」");
    }
  });

  it("英文界面同样不被 replace 特殊序列吞字", () => {
    expect(echoText("a$&b", "en-US")).toBe('No content matches "a$&b"');
  });

  it("值里字面出现的 {term} 不会被二次插值", () => {
    expect(echoText("{term}")).toBe("内容搜索没有命中「{term}」");
  });

  it("数字参数按字符串插入，漏参时占位符原样留着便于发现", () => {
    localStorage.setItem("locale", "zh-CN");
    function Numbers() {
      const { t } = useTranslation();
      return (
        <div>
          <span data-testid="line">{t("config.jumpToLine", { line: 12 })}</span>
          <span data-testid="bare">{t("config.contentSearchEmpty")}</span>
        </div>
      );
    }
    render(
      <I18nProvider>
        <Numbers />
      </I18nProvider>
    );
    expect(screen.getByTestId("line").textContent).toBe("跳到第 12 行");
    expect(screen.getByTestId("bare").textContent).toBe("内容搜索没有命中「{term}」");
  });
});
