/**
 * @vitest-environment jsdom
 */
import { act, render, screen, waitFor } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import SettingsView from "./SettingsView";
import { formatDateTime } from "../lib/formatDateTime";
import type { AppDataBackupActivity } from "../store/appDataBackup";

// 轮47 R47-03：设置页的「最后备份」由面板上报驱动。
// 用桩替掉面板，才能把「面板写完 → 上报 → 设置页立刻显示」这条线单独钉住，
// 而不必在测试里跑完整的导出/恢复流程。
const panelMocks = vi.hoisted(() => ({
  report: null as ((activities: AppDataBackupActivity[]) => void) | null,
}));

vi.mock("./AppDataBackupPanel", () => ({
  default: function MockPanel({ onActivitiesChange }: { onActivitiesChange?: (activities: AppDataBackupActivity[]) => void }) {
    panelMocks.report = onActivitiesChange ?? null;
    return <div data-testid="app-data-backup-panel" />;
  },
}));

vi.mock("../lib/appDataDoc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/appDataDoc")>();
  return {
    ...actual,
    getAppDataDocInfo: vi.fn(async () => ({
      path: "/data/app-data/confscope-data.json",
      savedAt: "2026-10-20T00:00:00.000Z",
      corruptFile: "",
      sizeBytes: 1024,
    })),
  };
});

vi.mock("../../wailsjs/go/app/App", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../wailsjs/go/app/App")>();
  return {
    ...actual,
    GetDataLocations: vi.fn(async () => ({ root: "/data", entries: [] })),
    OpenDataFolder: vi.fn(async () => undefined),
  };
});

function successActivity(createdAt: string): AppDataBackupActivity {
  return { id: `act-${createdAt}`, type: "local_export", status: "success", target: "/tmp/confscope.csbackup", message: "ok", createdAt };
}

describe("SettingsView 的最后备份", () => {
  beforeEach(() => {
    panelMocks.report = null;
    localStorage.clear();
    localStorage.setItem("locale", "en-US");
    localStorage.setItem("cs.appDataBackup", JSON.stringify({ webdav: {}, activities: [] }));
  });

  it("挂载时没有成功备份就不显示这一行", async () => {
    render(
      <I18nProvider>
        <SettingsView onOpenAbout={() => undefined} />
      </I18nProvider>
    );
    await screen.findByTestId("app-data-backup-panel");
    expect(screen.queryByText(/Last backup/)).not.toBeInTheDocument();
  });

  it("面板上报新的成功备份后，这一行立刻出现，不靠设置页自己重渲染", async () => {
    render(
      <I18nProvider>
        <SettingsView onOpenAbout={() => undefined} />
      </I18nProvider>
    );
    await screen.findByTestId("app-data-backup-panel");
    const report = panelMocks.report;
    if (!report) throw new Error("AppDataBackupPanel 的 onActivitiesChange 没接上");

    act(() => {
      report([successActivity("2026-10-20T08:30:00.000Z")]);
    });

    await waitFor(() => expect(screen.getByText(/Last backup/)).toBeInTheDocument());
    expect(screen.getByText(/Last backup/).textContent).toContain(formatDateTime("2026-10-20T08:30:00.000Z"));
  });
});
