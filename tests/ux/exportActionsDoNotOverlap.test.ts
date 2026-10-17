/**
 * 导出动作不得重叠执行（轮18 波44 R73）。
 *
 * 取证时踩到的坑：`ConfigBrowser` 里「导出源文件到目录」要先弹一个**原生**目录对话框，
 * 等用户选路径的那几百毫秒里按钮照旧可点，连点就叠开第二个对话框，
 * 两个导出任务再往同一目录交错写同一批文件（taskmanager.createTask 每次新 id，不去重）。
 *
 * 光靠行为测试钉不住这件事：浏览器和 jsdom 都不在 `disabled` 的按钮上派发 click，
 * 所以「摘掉早退 / 摘掉 finally」这两种负控实测仍是绿的——`disabled` 把状态闸的路径全遮住了。
 * 于是这条守卫直接把纪律钉在源码上：闸必须在，且必须是 try/finally 成对的闸。
 * 这样即便将来有人为了「导出中也能点同步导出」摘掉 disabled，早退和清位已经先存在了。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource, stripComments } from "./scanUtils";

const FILE = "src/components/ConfigBrowser.tsx";
const source = stripComments(readScannedSource(FILE));

/** 取箭头函数体：从 `const NAME = ... => {` 的首个左花括号走到配对的右花括号。 */
function functionBody(name: string): string {
  const decl = new RegExp("const " + name + "\\s*=");
  const found = decl.exec(source);
  expect(found, `${FILE} 里应当存在 ${name}`).not.toBeNull();
  const open = source.indexOf("{", (found as RegExpExecArray).index);
  expect(open, `${name} 应当是函数体写法`).toBeGreaterThan(-1);

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`${name} 的函数体没有闭合，解析器需要修`);
}

/**
 * 取某个 handler 所在 <button> 的开标签。
 * 必须带引号与花括号/圆括号深度感知：`=>` 里也含 `>`，
 * 而 `[^<>]*` 这种朴素正则会从更早的无关 <button> 一路跨过来，把别人的属性当成它的。
 */
function buttonTagFor(handler: string): string {
  const needle = "onClick={" + handler + "}";
  expect(source.split(needle).length - 1, `${handler} 的点击站点应当唯一`).toBe(1);
  const at = source.indexOf(needle);
  const start = source.lastIndexOf("<button", at);
  expect(start, `${handler} 应当挂在 <button> 上`).toBeGreaterThan(-1);

  let depth = 0;
  let quote = "";
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "(") depth += 1;
    else if (ch === "}" || ch === ")") depth -= 1;
    else if (ch === ">" && depth === 0 && source[i - 1] !== "=") return source.slice(start, i + 1);
  }
  throw new Error(`${handler} 的开标签没有收尾，解析器需要修`);
}

describe("导出动作不得重叠执行（波44 R73）", () => {
  it("异步导出在第一个 await 之前就闸住重入", () => {
    const body = functionBody("exportSourceFilesToDirectory");
    // 解析器自证：函数体应当真的含那次原生对话框调用，否则下面所有断言都在空集上假绿
    expect(body).toContain("runExportSourceFilesToDirectory");
    expect(body.length).toBeGreaterThan(120);

    const guard = /if \((\w+)\) return;/.exec(body);
    expect(guard, "异步导出必须有一句在途早退").not.toBeNull();
    const firstAwait = body.indexOf("await");
    expect(firstAwait).toBeGreaterThan(-1);
    expect((guard as RegExpExecArray).index).toBeLessThan(firstAwait);
  });

  it("在途标志用 try/finally 成对清位，成功与失败都要落回 false", () => {
    const body = functionBody("exportSourceFilesToDirectory");
    expect(body).toMatch(/setSourceExporting\(true\);/);
    expect(body).toMatch(/\}\s*finally\s*\{\s*setSourceExporting\(false\);\s*\}/);
    // 只许在 finally 里清位：写在 try 尾巴上等于失败路径永久锁死
    const clears = Array.from(body.matchAll(/setSourceExporting\(false\)/g));
    expect(clears).toHaveLength(1);
  });

  it("同步的当前列表导出也不得与异步导出交错写同一批配置", () => {
    const body = functionBody("exportCurrentList");
    expect(body).toMatch(/^\s*if \(sourceExporting\) return;/);
  });

  it("既有的快照护栏不许被顺手删掉", () => {
    const body = functionBody("createSnapshot");
    expect(body).toMatch(/if \([^)]*snapshotSaving[^)]*\) return;/);
    expect(body).toMatch(/setSnapshotSaving\(true\)/);
    expect(body).toMatch(/\}\s*finally\s*\{\s*setSnapshotSaving\(false\);\s*\}/);
  });

  it("两个导出按钮在途期间都禁用，并把原因写进 title 与 aria-label", () => {
    for (const handler of ["exportCurrentList", "exportSourceFilesToDirectory"]) {
      const attrs = buttonTagFor(handler);
      expect(attrs).toContain("disabled={sourceExporting}");
      expect(attrs).toMatch(/title=\{\s*sourceExporting\s*\?\s*t\("config\.exportInFlight"\)/);
      expect(attrs).toMatch(/aria-label=\{\s*sourceExporting\s*\?\s*t\("config\.exportInFlight"\)/);
      // 空闲态必须回到各自的动作名，不能把「导出进行中…」当成永久标签
      expect(attrs).toMatch(/:\s*t\("config\.(exportCurrentList|exportSourceFilesToDirectory)"\)\s*\}/);
    }
  });

  it("在途原因文案中英双份都齐", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const value = loadLocale(file)["config.exportInFlight"];
      expect(value, `${file} 缺 config.exportInFlight`).toBeTruthy();
      expect(value).not.toMatch(/^\s*$/);
    }
  });

  it("解析器自证：注释里的假护栏与 => 里的尖括号都骗不过它", () => {
    // 替身源码：护栏只存在于注释里，开标签属性里带 =>，函数体含嵌套花括号
    const fake = [
      "const decoy = () => {",
      "  // if (busy) return; } finally { setBusy(false); }",
      "  const inner = { a: { b: 1 } };",
      "  return inner;",
      "};",
      'fireEvent.click(getByText("x") as HTMLElement);',
      "<button",
      "  onChange={(e) => setV(e.target.value)}",
      "  onClick={decoy}",
      ">",
    ].join("\n");

    const cleaned = stripComments(fake);
    expect(cleaned, "注释必须真的被清掉").not.toContain("finally");
    const open = cleaned.indexOf("{");
    let depth = 0;
    let close = -1;
    for (let i = open; i < cleaned.length; i += 1) {
      if (cleaned[i] === "{") depth += 1;
      else if (cleaned[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    const body = cleaned.slice(open + 1, close);
    expect(body).toContain("const inner");
    expect(body).not.toContain("setV");

    // => 的那个 > 不能把开标签提前截断，否则属性断言只看得到半截标签
    const start = cleaned.indexOf("<button");
    const tag = (() => {
      let d = 0;
      let q = "";
      for (let i = start + 1; i < cleaned.length; i += 1) {
        const ch = cleaned[i];
        if (q) {
          if (ch === q) q = "";
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          q = ch;
          continue;
        }
        if (ch === "{" || ch === "(") d += 1;
        else if (ch === "}" || ch === ")") d -= 1;
        else if (ch === ">" && d === 0 && cleaned[i - 1] !== "=") return cleaned.slice(start, i + 1);
      }
      return "";
    })();
    expect(tag).toContain("onClick={decoy}");
    expect(tag).toContain("onChange=");
  });
});
