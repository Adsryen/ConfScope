/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import StartupDialog from "./StartupDialog";

interface CanvasMock {
  operations: string[];
  context: CanvasRenderingContext2D;
}

interface AnimationMock {
  runFrames: (limit: number) => void;
}

function mockAnimationFrame(): AnimationMock {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    callbacks.delete(id);
  });

  return {
    runFrames: (limit: number) => {
      for (let i = 0; i < limit; i += 1) {
        const [id, callback] = callbacks.entries().next().value ?? [];
        if (!id || !callback) return;
        callbacks.delete(id);
        callback(i * 16);
      }
    },
  };
}

function mockCanvas(): CanvasMock {
  const operations: string[] = [];
  const context = {
    clearRect: vi.fn(() => operations.push("clearRect")),
    fillRect: vi.fn(() => operations.push("fillRect")),
    beginPath: vi.fn(() => operations.push("beginPath")),
    moveTo: vi.fn(() => operations.push("moveTo")),
    lineTo: vi.fn(() => operations.push("lineTo")),
    arc: vi.fn(() => operations.push("arc")),
    fill: vi.fn(() => operations.push("fill")),
    stroke: vi.fn(() => operations.push("stroke")),
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
  return { operations, context };
}

function renderDialog(kind: "welcome" | "updated", options: { reducedMotion?: boolean } = {}) {
  localStorage.setItem("locale", "en-US");
  const canvas = mockCanvas();
  const animation = mockAnimationFrame();
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
    canvas,
    animation,
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

  it("shows update notes with fireworks", () => {
    renderDialog("updated");

    expect(screen.getByRole("dialog", { name: "Updated to v1.3.0" })).toBeInTheDocument();
    expect(screen.getByText("Added local snapshots and backup management")).toBeInTheDocument();
    expect(screen.getByTestId("startup-fireworks")).toBeInTheDocument();
  });

  it("clears the canvas after the fireworks animation finishes", () => {
    const { animation, canvas } = renderDialog("welcome");

    animation.runFrames(220);

    expect(canvas.operations[canvas.operations.length - 1]).toBe("clearRect");
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
