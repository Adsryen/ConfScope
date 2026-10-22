import { describe, expect, it } from "vitest";
import { DEFAULT_ENVIRONMENT_NAME, DEFAULT_PROJECT_NAME, DEFAULT_SOURCE_NAME, type Connection } from "../store/connections";
import { connectionLabel, environmentLabel, localizeDefaultName, projectLabel, sourceLabel } from "./defaultNameCopy";

// 只喂一个假 t：哨兵键 → 英文；其余键按未命中口径把 key 原样吐回来。
const enT = (key: string) =>
  ({
    "connection.defaultProjectName": "Default Project",
    "connection.defaultEnvironmentName": "Ungrouped",
    "connection.defaultSourceName": "Default Source",
  })[key] ?? key;
const zhT = (key: string) =>
  ({
    "connection.defaultProjectName": "默认项目",
    "connection.defaultEnvironmentName": "未分组",
    "connection.defaultSourceName": "默认来源",
  })[key] ?? key;

describe("localizeDefaultName 只翻三个内置默认名", () => {
  it("哨兵值按当前语言翻译", () => {
    expect(localizeDefaultName(DEFAULT_PROJECT_NAME, enT)).toBe("Default Project");
    expect(localizeDefaultName(DEFAULT_ENVIRONMENT_NAME, enT)).toBe("Ungrouped");
    expect(localizeDefaultName(DEFAULT_SOURCE_NAME, enT)).toBe("Default Source");
    expect(localizeDefaultName(DEFAULT_PROJECT_NAME, zhT)).toBe("默认项目");
  });

  it("用户自取的名字原样返回（不能被当成默认值改掉）", () => {
    expect(localizeDefaultName("支付中台", enT)).toBe("支付中台");
    expect(localizeDefaultName("", enT)).toBe("");
  });

  it("i18n 未命中时退回中文原值，绝不露 connection.xxx 这样的键名", () => {
    expect(localizeDefaultName(DEFAULT_PROJECT_NAME, (k) => k)).toBe(DEFAULT_PROJECT_NAME);
  });
});

describe("展示层 label 与 raw 匹配键分离", () => {
  const conn = {
    id: "c1",
    name: "订单服务配置",
    projectName: DEFAULT_PROJECT_NAME,
    environmentName: DEFAULT_ENVIRONMENT_NAME,
    sourceName: DEFAULT_SOURCE_NAME,
  } as unknown as Connection;
  const blank = { id: "c2", name: "" } as unknown as Connection;

  it("三段全默认时英文版拼成 Default Project / Ungrouped / Default Source", () => {
    expect(connectionLabel(conn, enT)).toBe("Default Project / Ungrouped / Default Source");
  });

  it("字段为空（存档里没有）时兜底到默认名并同样翻译", () => {
    expect(projectLabel(blank, enT)).toBe("Default Project");
    expect(environmentLabel(blank, enT)).toBe("Ungrouped");
    expect(sourceLabel(blank, enT)).toBe("Default Source");
  });

  it("用户改名后不参与翻译", () => {
    const named = { ...conn, projectName: "交易中台", environmentName: "生产" } as Connection;
    expect(connectionLabel(named, enT)).toBe("交易中台 / 生产 / Default Source");
  });
});
