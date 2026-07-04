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
});
