/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import SettingsView from "./SettingsView";

const credentialMocks = vi.hoisted(() => ({
  countMigratableStoredCredentials: vi.fn(() => 0),
  migrateStoredCredentials: vi.fn(),
}));

vi.mock("../lib/credentialSecrets", async () => {
  const actual = await vi.importActual<typeof import("../lib/credentialSecrets")>("../lib/credentialSecrets");
  return {
    ...actual,
    countMigratableStoredCredentials: credentialMocks.countMigratableStoredCredentials,
    migrateStoredCredentials: credentialMocks.migrateStoredCredentials,
  };
});

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function renderSettings(locale: "zh-CN" | "en-US" = "en-US") {
  vi.stubGlobal("localStorage", new MemoryStorage());
  localStorage.setItem("locale", locale);
  return render(
    <I18nProvider>
      <SettingsView />
    </I18nProvider>
  );
}

describe("SettingsView", () => {
  beforeEach(() => {
    credentialMocks.countMigratableStoredCredentials.mockReset();
    credentialMocks.countMigratableStoredCredentials.mockReturnValue(0);
    credentialMocks.migrateStoredCredentials.mockReset();
  });

  it("renders a grouped settings workbench without empty standalone sections", () => {
    renderSettings("en-US");

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Network" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Smart Compare" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Credentials" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Backup" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Local Data" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "App Data Backup" })).toBeInTheDocument();
    expect(
      screen.getByText("Connection-specific credentials, SSH tunnels, and security policies stay in Connection Manager.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Authentication" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Security" })).not.toBeInTheDocument();
  });

  it("runs credential migration and refreshes the migration summary", async () => {
    credentialMocks.countMigratableStoredCredentials.mockReturnValueOnce(3).mockReturnValue(0);
    credentialMocks.migrateStoredCredentials.mockResolvedValue({
      migrated: 2,
      skipped: 4,
      unsupported: 1,
      failed: 0,
      items: [],
    });

    renderSettings("en-US");

    expect(screen.getByText("3 credentials ready to migrate")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Migrate Credentials" }));

    await waitFor(() => expect(credentialMocks.migrateStoredCredentials).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Migrated 2 · Unsupported 1 · Failed 0")).toBeInTheDocument();
    expect(screen.getByText("No plaintext credentials to migrate")).toBeInTheDocument();
  });

  it("keeps language, proxy, compare, and local data controls working", () => {
    renderSettings("en-US");

    fireEvent.click(screen.getByLabelText("Sort connection dropdowns by name"));
    const httpInputs = screen.getAllByPlaceholderText("http://127.0.0.1:7890");
    fireEvent.change(httpInputs[0], {
      target: { value: "http://127.0.0.1:7890" },
    });

    expect(screen.getByRole("button", { name: "Clear Local History" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("cs.settings") || "{}")).toEqual(
      expect.objectContaining({
        compare: expect.objectContaining({ sortConnections: false }),
        proxy: expect.objectContaining({ httpProxy: "http://127.0.0.1:7890" }),
      })
    );
  });

  it("scrolls the settings panel container from rail navigation", () => {
    renderSettings("en-US");
    const panels = document.querySelector(".settings-panels") as HTMLDivElement;
    const backupPanel = document.getElementById("settings-backup") as HTMLElement;
    const scrollTo = vi.fn();
    const scrollIntoView = vi.fn();
    panels.scrollTo = scrollTo;
    backupPanel.scrollIntoView = scrollIntoView;
    Object.defineProperty(panels, "scrollTop", { value: 120, configurable: true });
    panels.getBoundingClientRect = vi.fn(() => new DOMRect(0, 20, 0, 0));
    backupPanel.getBoundingClientRect = vi.fn(() => new DOMRect(0, 420, 0, 0));

    fireEvent.click(screen.getByRole("button", { name: "Backup" }));

    expect(scrollTo).toHaveBeenCalledWith({ top: 520, behavior: "smooth" });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
