// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import OperationHistoryView from "./OperationHistoryView";

vi.mock("../api/nacos", () => ({
  listHistory: vi.fn(),
}));

describe("OperationHistoryView", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("locale", "zh-CN");
  });

  it("allows copying the error detail from a failed operation record", async () => {
    localStorage.setItem(
      "cs.operationHistory",
      JSON.stringify([
        {
          id: "record-1",
          type: "delete",
          result: "failure",
          timestamp: "2026-07-03T10:00:00Z",
          connectionId: "conn-1",
          connectionName: "prod",
          namespace: "public",
          group: "DEFAULT_GROUP",
          dataId: "app.yaml",
          error: "permission denied",
        },
      ])
    );

    render(
      <I18nProvider>
        <OperationHistoryView connections={[]} />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("app.yaml")).toBeDefined();
    });

    fireEvent.click(screen.getByText("app.yaml"));

    expect(screen.getByText("permission denied")).toBeDefined();
    expect(screen.getByRole("button", { name: "复制错误" })).toBeDefined();
  });
});
