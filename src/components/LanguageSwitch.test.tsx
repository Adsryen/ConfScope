/**
 * @vitest-environment jsdom
 */
import { render, screen } from "../test/react";
import { beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import LanguageSwitch from "./LanguageSwitch";

describe("LanguageSwitch", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("localizes the language switch title", () => {
    localStorage.setItem("locale", "en-US");

    render(
      <I18nProvider>
        <LanguageSwitch />
      </I18nProvider>
    );

    expect(screen.getByTitle("Language")).toBeInTheDocument();
  });
});
