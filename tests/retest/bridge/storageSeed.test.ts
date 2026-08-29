import { describe, expect, it } from "vitest";
import { createRetestStorageSeed } from "./storageSeed";
import { loadRetestState } from "../state";

describe("retest storage seed", () => {
  it("always seeds connections with the default group", () => {
    const seed = createRetestStorageSeed(loadRetestState());
    const connKey = seed.find((item) => item.key === "cs.connections");
    expect(connKey).toBeDefined();
    const conns = JSON.parse(connKey!.value) as Array<Record<string, unknown>>;
    expect(conns).toHaveLength(2);
    for (const conn of conns) {
      expect(conn.defaultGroup).toBe("RETEST-PROD");
    }
  });
});
