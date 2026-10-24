/**
 * 视图状态只许有一份存取实现（R27）。
 *
 * 为什么要静态读源码：这条约束跨 4 个文件（一份实现 + 三个接入页），
 * 而它的失效方式是「某天有人在某页顺手写了一行 sessionStorage」——
 * 组件单测照样绿，但两本账开始各记各的，切走回来的状态就时对时错，
 * 而且再没人知道哪本是真的。jsdom 用例只能证明「本页面能恢复」，
 * 证明不了「全站只有这一处」，只能靠静态扫描一次守死。
 * 与 tests/ux/toasterStacking.test.ts 同一口径：跨文件的纪律只守一次。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "./scanUtils";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const STORE_PATH = "src/lib/viewState.ts";
/** 已接入记忆层的四个非浏览页（轮67 把设置页的整页面板也接了进来）。 */
const PAGES: Array<{ rel: string; namespace: string; scrollKey: string }> = [
  { rel: "src/components/AuditView.tsx", namespace: "audit", scrollKey: "audit.scroll.matrix" },
  { rel: "src/components/SettingsView.tsx", namespace: "settings", scrollKey: "settings.scroll.panels" },
  { rel: "src/components/OperationHistoryView.tsx", namespace: "history", scrollKey: "history.scroll.list" },
  { rel: "src/components/BackupView.tsx", namespace: "backup", scrollKey: "backup.scroll.list" },
];

/** 只取字面量 key 的调用：useRememberedState("x") / useScrollMemory("x") / read|writeViewState("x")。 */
const KEY_CALL_RE = /(?:use(?:RememberedState|ScrollMemory)|(?:read|write)ViewState)[^(\n]*\(\s*"([^"]+)"/g;
/**  hook 调用总数（含传变量 key 的写法），用来逼出「key 必须是写死的字面量」。 */
const HOOK_CALL_RE = /use(?:RememberedState|ScrollMemory)</g;

function read(rel: string): string {
  return readFileSync(join(PROJECT_ROOT, rel), "utf8");
}

/**
 * 剥掉注释后的代码（轮72B）。
 *
 * 「四页不许自己碰存储」这条禁的是**行为**，不是这个词：解释为什么这里要一次读全量、
 * 为什么不许逐行 getApplyPlan() 的注释里，本来就该能写 localStorage 这个名字。
 * 原先直接对原文做子串判断，注释一提这个词就判红，等于在教后人把注释写含糊——
 * 与本仓 scanUtils.stripComments 的口径也不一致（它专门带引号状态机，URL 里的 `//` 不算注释）。
 * 剥注释只会让扫描更准，不会更松：真写了 `localStorage.setItem(...)` 一样命中。
 */
function code(rel: string): string {
  return stripComments(read(rel));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function rememberedKeys(rel: string): string[] {
  return Array.from(new Set(Array.from(read(rel).matchAll(KEY_CALL_RE), (match) => match[1])));
}

describe("视图状态的唯一实现", () => {
  it("lib/viewState 把读写与两个 hook 都导出，页面不许另起炉灶", () => {
    const store = read(STORE_PATH);
    ["readViewState", "writeViewState", "clearViewState", "viewStateKeys", "useRememberedState", "useScrollMemory"].forEach((name) => {
      expect(store, `lib/viewState.ts 缺少 ${name}`).toContain(`export function ${name}`);
    });
    expect(store).toMatch(/const values = new Map<string, unknown>\(\)/);
  });

  it("审计 / 设置 / 历史 / 备份四页都从同一份实现取状态，且都接了滚动记忆", () => {
    PAGES.forEach(({ rel, scrollKey }) => {
      const src = read(rel);
      expect(src, `${rel} 没有引用 ../lib/viewState`).toContain('from "../lib/viewState"');
      expect(src, `${rel} 缺少滚动位置记忆`).toContain(`useScrollMemory("${scrollKey}"`);
      expect(src, `${rel} 的滚动容器没绑 ref`).toMatch(/ref=\{[a-zA-Z]+Scroll\.ref\}/);
      expect(src, `${rel} 的滚动容器没绑 onScroll`).toMatch(/onScroll=\{[a-zA-Z]+Scroll\.onScroll\}/);
    });
  });

  it("四页不再自己写一套存储，也不手动摆弄 scrollTop", () => {
    PAGES.forEach(({ rel }) => {
      const src = code(rel);
      expect(src, `${rel} 直接用 sessionStorage 记状态`).not.toContain("sessionStorage");
      expect(src, `${rel} 直接用 localStorage 记状态`).not.toContain("localStorage");
      expect(src, `${rel} 自己给 scrollTop 赋值`).not.toMatch(/\.scrollTop\s*=[^=]/);
    });
  });

  it("自检：剥注释不许把守卫看盲（轮72B）", () => {
    // 同一段词，写在注释里放行、写在代码里必须照抓——这条是上面那条禁词用例的负控。
    const inComment = stripComments(`// localStorage.setItem("k", "v")\nconst a = 1; /* sessionStorage.clear() */\n`);
    expect(inComment.includes("localStorage"), "注释没剥掉").toBe(false);
    expect(inComment.includes("sessionStorage"), "块注释没剥掉").toBe(false);
    const inCode = stripComments(`localStorage.setItem("k", "v");\nconst url = "http://127.0.0.1:1420"; // 不是注释里的 localStorage\n`);
    expect(inCode.includes("localStorage"), "真代码里的 localStorage 被剥没了，守卫等于空转").toBe(true);
    // URL 里的 // 不能当注释：它后面的代码必须还在
    expect(inCode.includes('const url = "http://127.0.0.1:1420"'), "字符串里的 // 被当成注释，剥完会连带吃掉真代码").toBe(true);
  });

  it("整个 src 的非测试代码里，sessionStorage 只许出现在唯一实现的注释里", () => {
    const hits = walk(join(PROJECT_ROOT, "src"))
      .filter((full) => !full.endsWith(STORE_PATH))
      .filter((full) => stripComments(readFileSync(full, "utf8")).includes("sessionStorage"))
      .map((full) => full.slice(PROJECT_ROOT.length + 1));
    expect(hits, "出现了这个文件自己记视图状态").toEqual([]);
  });
});

describe("记忆键的命名空间", () => {
  it("每页的键都带自己的前缀，页面之间不共用", () => {
    const collected = PAGES.map(({ namespace, rel }) => ({ rel, keys: rememberedKeys(rel), namespace }));
    collected.forEach(({ rel, keys, namespace }) => {
      expect(keys.length, `${rel} 一个记忆键都没注册`).toBeGreaterThan(0);
      keys
        .filter((key) => !key.startsWith(`${namespace}.`))
        .forEach((key) => {
          expect.fail(`${rel} 的键 "${key}" 没带 ${namespace}. 前缀，会和别的页面串`);
        });
    });
    collected.forEach((left, index) => {
      collected.slice(index + 1).forEach((right) => {
        const shared = left.keys.filter((key) => right.keys.includes(key));
        expect(shared, `${left.rel} 和 ${right.rel} 共用了键`).toEqual([]);
      });
    });
  });

  it("key 一律写死成字面量，不靠变量拼接", () => {
    PAGES.forEach(({ rel }) => {
      const src = read(rel);
      const total =
        Array.from(src.matchAll(HOOK_CALL_RE)).length + Array.from(src.matchAll(/use(?:RememberedState|ScrollMemory)\(/g)).length;
      const literal = Array.from(src.matchAll(KEY_CALL_RE)).filter((match) => /use(?:RememberedState|ScrollMemory)/.test(match[0])).length;
      expect(literal, `${rel} 有 hook 的 key 不是字面量`).toBe(total);
    });
  });
});
