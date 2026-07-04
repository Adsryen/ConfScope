/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import StartupDialog from "./StartupDialog";

function renderDialog(kind: "welcome" | "updated", options: { reducedMotion?: boolean } = {}) {
  localStorage.setItem("locale", "en-US");
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillStyle: "",
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: options.reducedMotion === true && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  const onClose = vi.fn();
  return {
    onClose,
    ...render(
      <I18nProvider>
        <StartupDialog kind={kind} version="1.3.0" onClose={onClose} />
      </I18nProvider>
    ),
  };
}

describe("StartupDialog", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("shows the first-install welcome copy with fireworks", () => {
    renderDialog("welcome");

    expect(screen.getByRole("dialog", { name: "Welcome to ConfScope" })).toBeInTheDocument();
    expect(screen.getByText("Manage config-center connections in one place")).toBeInTheDocument();
    expect(screen.getByTestId("startup-fireworks")).toBeInTheDocument();
  });

  it("shows update notes without fireworks", () => {
    renderDialog("updated");

    expect(screen.getByRole("dialog", { name: "Updated to v1.3.0" })).toBeInTheDocument();
    expect(screen.getByText("Added local snapshots and backup management")).toBeInTheDocument();
    expect(screen.queryByTestId("startup-fireworks")).not.toBeInTheDocument();
  });

  it("calls onClose from the primary action", () => {
    const { onClose } = renderDialog("updated");

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not render fireworks when reduced motion is preferred", () => {
    renderDialog("welcome", { reducedMotion: true });

    expect(screen.queryByTestId("startup-fireworks")).not.toBeInTheDocument();
  });
});
