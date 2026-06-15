// 行级 diff：基于 LCS（最长公共子序列）对齐两侧文本，产出可并排渲染的行。
// 配置文件通常不大（几千行内），O(n*m) 的 DP 足够且实现简单稳定。

export type RowType = "equal" | "add" | "del" | "modify";

export interface DiffRow {
  type: RowType;
  /** 左侧行号（1 起），无则 null。 */
  leftNo: number | null;
  /** 右侧行号（1 起），无则 null。 */
  rightNo: number | null;
  left: string | null;
  right: string | null;
}

export interface DiffResult {
  rows: DiffRow[];
  added: number;
  removed: number;
  modified: number;
}

function splitLines(text: string): string[] {
  // 统一换行；末尾换行不产出多余空行。
  const norm = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (norm === "") return [];
  return norm.split("\n");
}

/** 计算两段文本的并排 diff。 */
export function diffLines(leftText: string, rightText: string): DiffResult {
  const a = splitLines(leftText);
  const b = splitLines(rightText);
  const n = a.length;
  const m = b.length;

  // LCS 长度表
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // 回溯，产出 equal / del(只在左) / add(只在右) 的原始序列
  type Raw = { kind: "equal" | "del" | "add"; left?: string; right?: string };
  const raw: Raw[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      raw.push({ kind: "equal", left: a[i], right: b[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      raw.push({ kind: "del", left: a[i] });
      i++;
    } else {
      raw.push({ kind: "add", right: b[j] });
      j++;
    }
  }
  while (i < n) raw.push({ kind: "del", left: a[i++] });
  while (j < m) raw.push({ kind: "add", right: b[j++] });

  // 把相邻的 del+add 合并为 modify（同一逻辑行的改动），更贴近「智能」对比观感
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let modified = 0;
  let leftNo = 0;
  let rightNo = 0;

  for (let k = 0; k < raw.length; k++) {
    const cur = raw[k];
    if (cur.kind === "equal") {
      leftNo++;
      rightNo++;
      rows.push({ type: "equal", leftNo, rightNo, left: cur.left!, right: cur.right! });
      continue;
    }
    if (cur.kind === "del") {
      // 收集连续的 del 与紧随其后的连续 add，配对成 modify
      const dels: string[] = [];
      while (k < raw.length && raw[k].kind === "del") dels.push(raw[k++].left!);
      const adds: string[] = [];
      while (k < raw.length && raw[k].kind === "add") adds.push(raw[k++].right!);
      k--; // for 循环会再 ++

      const pairs = Math.min(dels.length, adds.length);
      for (let p = 0; p < pairs; p++) {
        leftNo++;
        rightNo++;
        modified++;
        rows.push({ type: "modify", leftNo, rightNo, left: dels[p], right: adds[p] });
      }
      for (let d = pairs; d < dels.length; d++) {
        leftNo++;
        removed++;
        rows.push({ type: "del", leftNo, rightNo: null, left: dels[d], right: null });
      }
      for (let ad = pairs; ad < adds.length; ad++) {
        rightNo++;
        added++;
        rows.push({ type: "add", leftNo: null, rightNo, left: null, right: adds[ad] });
      }
      continue;
    }
    // 纯 add（前面没有 del）
    rightNo++;
    added++;
    rows.push({ type: "add", leftNo: null, rightNo, left: null, right: cur.right! });
  }

  return { rows, added, removed, modified };
}
