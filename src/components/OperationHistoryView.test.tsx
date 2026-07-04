// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import type { Connection } from "../store/connections";
import { loadOperationHistory } from "../store/operationHistory";
import OperationHistoryView from "./OperationHistoryView";

const nacosMocks = vi.hoisted(() => ({
  listHistory: vi.fn(),
  getConfig: vi.fn(),
  publishConfig: vi.fn(),
}));

vi.mock("../api/nacos", async () => {
  const actual = await vi.importActual<typeof import("../api/nacos")>("../api/nacos");
  return {
    ...actual,
    listHistory: nacosMocks.listHistory,
    getConfig: nacosMocks.getConfig,
    publishConfig: nacosMocks.publishConfig,
  };
});

vi.mock("../lib/toast", () => ({
  toast: vi.fn(),
}));

const conn: Connection = {
  id: "conn-1",
  name: "prod",
  baseUrl: "http://localhost:8848/nacos",
  username: "nacos",
  password: "nacos",
  defaultNamespace: "public",
};

const rollbackablePublishRecord = {
  id: "record-rollbackable",
  type: "publish",
  result: "success",
  timestamp: "2026-07-04T10:00:00Z",
  connectionId: "conn-1",
  connectionName: "prod",
  namespace: "public",
  group: "DEFAULT_GROUP",
  dataId: "app.yaml",
  beforeContent: "old: true",
  afterContent: "new: true",
  configType: "yaml",
  rollbackable: true,
};

describe("OperationHistoryView", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("locale", "zh-CN");
    nacosMocks.listHistory.mockReset();
    nacosMocks.getConfig.mockReset();
    nacosMocks.publishConfig.mockReset();
    nacosMocks.listHistory.mockResolvedValue({ pageItems: [] });
    nacosMocks.getConfig.mockResolvedValue("current: true");
    nacosMocks.publishConfig.mockResolvedValue(undefined);
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

  it("shows rollback action for a rollbackable operation record", async () => {
    localStorage.setItem("cs.operationHistory", JSON.stringify([rollbackablePublishRecord]));

    render(
      <I18nProvider>
        <OperationHistoryView connections={[conn]} />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));

    expect(screen.getByText("共 1 条记录")).toBeDefined();
    expect(screen.getByText("可回滚")).toBeDefined();
    expect(screen.getByRole("button", { name: "复制记录" })).toBeDefined();
    expect(screen.getByRole("button", { name: "回滚此操作" })).toBeDefined();
  });

  it("publishes the previous content and records a new rollback entry", async () => {
    localStorage.setItem("cs.operationHistory", JSON.stringify([rollbackablePublishRecord]));

    render(
      <I18nProvider>
        <OperationHistoryView connections={[conn]} />
      </I18nProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: /app.yaml/ }));
    fireEvent.click(screen.getByRole("button", { name: "回滚此操作" }));
    fireEvent.click(screen.getByRole("button", { name: "确认回滚" }));

    await waitFor(() => {
      expect(nacosMocks.publishConfig).toHaveBeenCalledWith(conn, "public", "app.yaml", "DEFAULT_GROUP", "old: true", "yaml");
    });

    const rollbackRecord = loadOperationHistory().find((record) => record.type === "rollback");
    expect(rollbackRecord).toMatchObject({
      type: "rollback",
      result: "success",
      connectionId: "conn-1",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      beforeContent: "current: true",
      afterContent: "old: true",
      rollbackable: true,
      resourceId: "record-rollbackable",
    });
  });
});
