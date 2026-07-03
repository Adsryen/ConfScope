import { describe, it, expect } from "vitest";
import {
  getSnapshotStats,
  formatSnapshotName,
  formatTime,
  compareSnapshots,
} from "./snapshot";
import type { Snapshot } from "../api/snapshot";

describe("snapshot", () => {
  const sampleSnapshot: Snapshot = {
    id: "snap_123",
    path: "C:\\Users\\tester\\.confscope\\backups\\snap_123",
    name: "dev-nacos_public_20240101_100000",
    description: "",
    createdAt: "2024-01-01T10:00:00Z",
    updatedAt: "2024-01-01T10:00:00Z",
    source: {
      connectionId: "conn-1",
      connectionName: "dev-nacos",
      namespace: "public",
      namespaceId: "public",
    },
    configs: [
      {
        dataId: "app.yaml",
        group: "DEFAULT_GROUP",
        content: "server:\n  port: 8080",
        configType: "yaml",
        updateTime: "2024-01-01 10:00:00",
      },
      {
        dataId: "db.properties",
        group: "DEFAULT_GROUP",
        content: "db.url=jdbc:mysql://localhost:3306/test",
        configType: "properties",
        updateTime: "2024-01-02 12:00:00",
      },
      {
        dataId: "app2.yaml",
        group: "GROUP2",
        content: "key: value",
        configType: "yaml",
        updateTime: "2024-01-03 14:00:00",
      },
    ],
  };

  describe("getSnapshotStats", () => {
    it("returns correct stats", () => {
      const stats = getSnapshotStats(sampleSnapshot);
      expect(stats.totalConfigs).toBe(3);
      expect(stats.totalGroups).toBe(2);
      expect(stats.totalNamespaces).toBe(1);
      expect(stats.latestUpdateTime).toBe("2024-01-03 14:00:00");
    });

    it("handles empty configs", () => {
      const emptySnapshot = { ...sampleSnapshot, configs: [] };
      const stats = getSnapshotStats(emptySnapshot);
      expect(stats.totalConfigs).toBe(0);
      expect(stats.latestUpdateTime).toBeNull();
    });
  });

  describe("formatSnapshotName", () => {
    it("returns name when available", () => {
      expect(formatSnapshotName(sampleSnapshot)).toBe("dev-nacos_public_20240101_100000");
    });

    it("returns id when name is empty", () => {
      const noName = { ...sampleSnapshot, name: "" };
      expect(formatSnapshotName(noName)).toBe("snap_123");
    });
  });

  describe("formatTime", () => {
    it("formats date string", () => {
      const result = formatTime("2024-01-15T10:30:00Z");
      expect(result).toContain("2024");
      expect(result).toContain("01");
      expect(result).toContain("15");
    });

    it("formats Date object", () => {
      const result = formatTime(new Date("2024-06-15T14:30:00Z"));
      expect(result).toContain("2024");
      expect(result).toContain("06");
    });
  });

  describe("compareSnapshots", () => {
    it("detects added configs", () => {
      const right = {
        ...sampleSnapshot,
        configs: [
          ...sampleSnapshot.configs,
          {
            dataId: "new.yaml",
            group: "DEFAULT_GROUP",
            content: "new: config",
            configType: "yaml",
            updateTime: "2024-01-04",
          },
        ],
      };
      const diffs = compareSnapshots(sampleSnapshot, right);
      const added = diffs.filter((d) => d.diffType === "added");
      expect(added).toHaveLength(1);
      expect(added[0].dataId).toBe("new.yaml");
    });

    it("detects deleted configs", () => {
      const right = {
        ...sampleSnapshot,
        configs: sampleSnapshot.configs.slice(0, 1),
      };
      const diffs = compareSnapshots(sampleSnapshot, right);
      const deleted = diffs.filter((d) => d.diffType === "deleted");
      expect(deleted).toHaveLength(2);
    });

    it("detects modified configs", () => {
      const right = {
        ...sampleSnapshot,
        configs: sampleSnapshot.configs.map((c) =>
          c.dataId === "app.yaml" ? { ...c, content: "server:\n  port: 9090" } : c
        ),
      };
      const diffs = compareSnapshots(sampleSnapshot, right);
      const modified = diffs.filter((d) => d.diffType === "modified");
      expect(modified).toHaveLength(1);
      expect(modified[0].dataId).toBe("app.yaml");
    });

    it("detects unchanged configs", () => {
      const diffs = compareSnapshots(sampleSnapshot, sampleSnapshot);
      const unchanged = diffs.filter((d) => d.diffType === "unchanged");
      expect(unchanged).toHaveLength(3);
    });
  });
});
