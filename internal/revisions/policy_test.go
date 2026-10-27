package revisions

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 本文件钉的是轮99 的三条判据：配额只有一个钳制点、钉住扛得住裁剪、
// 自动裁剪的触发量数的是「未钉住的条数」。
// 前两条决定用户数据会不会被静默删掉，第三条决定「钉住」会不会把追加式日志写成整文件反复重写。

func appendContents(t *testing.T, store *Store, dir string, from int, to int) {
	t.Helper()
	for i := from; i < to; i++ {
		in := observedInput("v\n")
		in.Content = fmt.Sprintf("v%d: %d\n", i, i)
		if _, err := store.Append(dir, in); err != nil {
			t.Fatalf("追加第 %d 条失败: %v", i, err)
		}
	}
}

func refFor(hash string) PinnedRef {
	return PinnedRef{ConnectionID: "conn-a", Namespace: "public", Group: "DEFAULT_GROUP", DataID: "app.yml", Hash: hash}
}

func TestPolicyResolvesWithSingleClampPoint(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()

	// 1) 还没写过策略：默认档，来源必须说清楚是「没设过」而不是「用户设成了 50」。
	policy, res := loadPolicy(dir)
	if res.KeepPerKey != DefaultKeepPerKey || res.Source != KeepSourceMissing {
		t.Fatalf("缺文件应回落默认并标 missing，实得 %+v %+v", policy, res)
	}

	// 2) 合法区间内的值原样生效。
	if _, err := store.SetPolicyKeepPerKey(dir, 25); err != nil {
		t.Fatalf("保存配额失败: %v", err)
	}
	_, res = loadPolicy(dir)
	if res.KeepPerKey != 25 || res.Source != KeepSourcePolicy {
		t.Fatalf("合法值应原样生效，实得 %+v", res)
	}

	// 3) 越界（上界外 / 下界外）一律回落默认，并如实标 out-of-range。
	for _, raw := range []int{MaxKeepPerKey + 1, MinKeepPerKey - 1, 0, -5} {
		if err := writePolicy(dir, Policy{Schema: PolicySchema, KeepPerKey: raw}); err != nil {
			t.Fatalf("直写越界配额 %d 失败: %v", raw, err)
		}
		_, res = loadPolicy(dir)
		if res.KeepPerKey != DefaultKeepPerKey || res.Source != KeepSourceOutOfRange {
			t.Fatalf("越界 %d 应回落默认并标 out-of-range，实得 %+v", raw, res)
		}
	}

	// 4) 文件坏掉：回落默认 + unreadable，且不报错（记这一版比读策略重要）。
	if err := os.WriteFile(filepath.Join(dir, PolicyFileName), []byte("{ not json"), 0o644); err != nil {
		t.Fatalf("写坏文件失败: %v", err)
	}
	_, res = loadPolicy(dir)
	if res.KeepPerKey != DefaultKeepPerKey || res.Source != KeepSourceUnreadable {
		t.Fatalf("坏文件应回落默认并标 unreadable，实得 %+v", res)
	}

	// 5) 坏掉之后仍要继续记得下这一版。
	appendContents(t, store, dir, 0, 1)
	if got := len(mustRead(t, store, dir, 0)); got != 1 {
		t.Fatalf("策略文件坏了不许挡住记版，实得 %d 条", got)
	}

	// 6) 保存走的是同一个钳制点：越界入参落盘的是默认值，不是入参本身。
	view, err := store.SetPolicyKeepPerKey(dir, 9_999)
	if err != nil {
		t.Fatalf("保存越界配额必须钳而不是报错: %v", err)
	}
	if view.KeepPerKey != DefaultKeepPerKey {
		t.Fatalf("越界入参必须钳到生效值，实得 %d", view.KeepPerKey)
	}
	if view.MinKeepPerKey != MinKeepPerKey || view.MaxKeepPerKey != MaxKeepPerKey || view.DefaultKeepPerKey != DefaultKeepPerKey {
		t.Fatalf("合法区间必须随视图回给界面，实得 %+v", view)
	}
}

func TestSavePolicyKeepsPinsAndWritesAtomically(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	appendContents(t, store, dir, 0, 2)
	records := mustReadKey(t, store, dir, "conn-a", "public", "DEFAULT_GROUP", "app.yml", 0)

	if _, err := store.SetPinned(dir, refFor(records[0].Hash), true); err != nil {
		t.Fatalf("钉住失败: %v", err)
	}
	view, err := store.SetPolicyKeepPerKey(dir, 30)
	if err != nil {
		t.Fatalf("改配额失败: %v", err)
	}
	if view.PinnedCount != 1 {
		t.Fatalf("改配额不得顺手丢掉钉住，实得 %d", view.PinnedCount)
	}

	// 落盘形状必须可读、字段齐全（策略文件是用户数据，坏了要能人工看出来）。
	raw, err := os.ReadFile(filepath.Join(dir, PolicyFileName))
	if err != nil {
		t.Fatalf("读策略文件失败: %v", err)
	}
	var stored map[string]any
	if err := json.Unmarshal(raw, &stored); err != nil {
		t.Fatalf("策略文件必须是合法 JSON: %v", err)
	}
	if stored["keepPerKey"].(float64) != 30 {
		t.Fatalf("文件里要念实际生效值，实得 %v", stored["keepPerKey"])
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("读目录失败: %v", err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp-") {
			t.Fatalf("策略落盘留下临时文件 %q", e.Name())
		}
	}
	info, err := os.Stat(filepath.Join(dir, PolicyFileName))
	if err != nil {
		t.Fatalf("stat 失败: %v", err)
	}
	if info.Mode().Perm() != 0o644 {
		t.Fatalf("策略文件权限应为 0644，实得 %v", info.Mode().Perm())
	}
}

func TestPruneKeepsPinnedBeyondQuota(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	appendContents(t, store, dir, 0, 22)
	if _, err := store.SetPolicyKeepPerKey(dir, MinKeepPerKey); err != nil {
		t.Fatalf("保存配额失败: %v", err)
	}
	records := mustReadKey(t, store, dir, "conn-a", "public", "DEFAULT_GROUP", "app.yml", 0)
	// 钉住第 2、3、4 新（都在会被裁掉的那一段里）
	pinnedHashes := []string{records[1].Hash, records[2].Hash, records[3].Hash}
	for _, hash := range pinnedHashes {
		res, err := store.SetPinned(dir, refFor(hash), true)
		if err != nil {
			t.Fatalf("钉住 %s 失败: %v", hash, err)
		}
		if res.Hits != 1 || !res.Pinned {
			t.Fatalf("钉住应命中 1 行并回 pinned=true，实得 %+v", res)
		}
	}

	removed, err := store.Prune(dir)
	if err != nil {
		t.Fatalf("裁剪失败: %v", err)
	}
	left := mustReadKey(t, store, dir, "conn-a", "public", "DEFAULT_GROUP", "app.yml", 0)
	if len(left) != MinKeepPerKey+1+len(pinnedHashes) {
		t.Fatalf("应剩「锚点 + 最近 %d 条未钉住 + %d 条钉住」= %d，实得 %d（删了 %d）",
			MinKeepPerKey, len(pinnedHashes), MinKeepPerKey+1+len(pinnedHashes), len(left), removed)
	}
	pinned := loadPolicyOrDefault(t, dir)
	for _, hash := range pinnedHashes {
		if !pinned[pinID(KeyOf("conn-a", "public", "DEFAULT_GROUP", "app.yml"), hash)] {
			t.Fatalf("钉住的行必须在集合里")
		}
	}
	seen := map[string]bool{}
	for _, rec := range left {
		seen[rec.Hash] = true
	}
	for _, hash := range pinnedHashes {
		if !seen[hash] {
			t.Fatalf("钉住的版本被裁剪删掉了：用户的「这一版不许丢」被程序越权执行")
		}
	}
}

func TestPinnedRowsDoNotTriggerRewriteOnEveryAppend(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	// 先按默认配额攒 60 版，再把它们全部钉住，然后把配额压到 10。
	appendContents(t, store, dir, 0, 60)
	before := mustReadKey(t, store, dir, "conn-a", "public", "DEFAULT_GROUP", "app.yml", 0)
	for _, rec := range before {
		if _, err := store.SetPinned(dir, refFor(rec.Hash), true); err != nil {
			t.Fatalf("钉住失败: %v", err)
		}
	}
	if _, err := store.SetPolicyKeepPerKey(dir, MinKeepPerKey); err != nil {
		t.Fatalf("保存配额失败: %v", err)
	}

	// 触发量必须数「未钉住的条数」：钉住 60 版远大于配额，也不该让每次追加都去重写整文件。
	// 判据取「条数什么时候才开始下降」——若实现仍按全部条数触发，第一条追加就会裁。
	for i := 60; i < 60+MinKeepPerKey*2; i++ {
		in := observedInput("v\n")
		in.Content = fmt.Sprintf("v%d: %d\n", i, i)
		if _, err := store.Append(dir, in); err != nil {
			t.Fatalf("追加第 %d 条失败: %v", i, err)
		}
		got := len(mustReadKey(t, store, dir, "conn-a", "public", "DEFAULT_GROUP", "app.yml", 0))
		if want := 60 + (i - 60) + 1; got != want {
			t.Fatalf("未钉住只有 %d 条（阈值 %d）时不该触发裁剪：第 %d 次追加后条数应为 %d，实得 %d",
				i-60+1, MinKeepPerKey*2, i-60+1, want, got)
		}
	}

	// 越过阈值这一次必须裁，且只裁未钉住的那一坨。
	in := observedInput("v\n")
	in.Content = fmt.Sprintf("v%d: %d\n", 60+MinKeepPerKey*2, 60+MinKeepPerKey*2)
	if _, err := store.Append(dir, in); err != nil {
		t.Fatalf("追加越阈值那条失败: %v", err)
	}
	left := mustReadKey(t, store, dir, "conn-a", "public", "DEFAULT_GROUP", "app.yml", 0)
	if len(left) != 60+MinKeepPerKey {
		t.Fatalf("越过阈值应裁到「60 条钉住 + 最近 %d 条未钉住」，实得 %d", MinKeepPerKey, len(left))
	}
}

func TestSetPinnedIsIdempotentAndMatchesEverySameContentRow(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	// A → B → A：同一内容在该键下真的会出现两行（改走又改回来），钉住必须一次命中两行。
	appendContents(t, store, dir, 0, 1)
	appendContents(t, store, dir, 1, 2)
	appendContents(t, store, dir, 0, 1)
	records := mustReadKey(t, store, dir, "conn-a", "public", "DEFAULT_GROUP", "app.yml", 0)
	shared := records[0].Hash
	if records[2].Hash != shared {
		t.Fatalf("测试前提不成立：首尾两版应当同内容")
	}

	res, err := store.SetPinned(dir, refFor(shared), true)
	if err != nil {
		t.Fatalf("钉住失败: %v", err)
	}
	if res.Hits != 2 || !res.Pinned || res.PinnedCount != 1 {
		t.Fatalf("同内容两行必须一次命中且只留一条标记，实得 %+v", res)
	}

	// 再钉一次：幂等，清单还是一条，且不许反复落盘（把 mtime 念成「刚刚写过」）。
	same, err := store.SetPinned(dir, refFor(shared), true)
	if err != nil {
		t.Fatalf("重复钉住不该报错: %v", err)
	}
	if !same.Pinned || same.PinnedCount != 1 {
		t.Fatalf("重复钉住必须维持原状，实得 %+v", same)
	}

	// 取消钉住：两行都回到未钉住一侧。
	off, err := store.SetPinned(dir, refFor(shared), false)
	if err != nil {
		t.Fatalf("取消钉住失败: %v", err)
	}
	if off.Pinned || off.PinnedCount != 0 {
		t.Fatalf("取消后清单应为空，实得 %+v", off)
	}
	if again, err := store.SetPinned(dir, refFor(shared), false); err != nil || again.Pinned {
		t.Fatalf("重复取消必须幂等且不报错，实得 %+v %v", again, err)
	}
}

func TestSetPinnedRefusesWhenNoSuchVersion(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	appendContents(t, store, dir, 0, 1)

	// 钉一个本机没有的摘要：不报错，但如实回 hits=0，且不许留悬空标记。
	res, err := store.SetPinned(dir, refFor("sha256:deadbeef"), true)
	if err != nil {
		t.Fatalf("钉住不存在的版本不该报错: %v", err)
	}
	if res.Pinned || res.Hits != 0 || res.PinnedCount != 0 {
		t.Fatalf("钉不住必须回 hits=0 且不落标记，实得 %+v", res)
	}
	if _, err := os.Stat(filepath.Join(dir, PolicyFileName)); !os.IsNotExist(err) {
		t.Fatalf("钉不住时不该造出策略文件: %v", err)
	}

	// 归属字段缺失是调用方的错，必须报错而不是静默忽略。
	if _, err := store.SetPinned(dir, PinnedRef{Hash: "sha256:1"}, true); err == nil {
		t.Fatal("缺少连接或 dataId 的钉住必须报错")
	}
}

func TestClearRemovesPinsButKeepsQuota(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	appendContents(t, store, dir, 0, 3)
	if _, err := store.SetPolicyKeepPerKey(dir, 30); err != nil {
		t.Fatalf("保存配额失败: %v", err)
	}
	records := mustReadKey(t, store, dir, "conn-a", "public", "DEFAULT_GROUP", "app.yml", 0)
	if _, err := store.SetPinned(dir, refFor(records[0].Hash), true); err != nil {
		t.Fatalf("钉住失败: %v", err)
	}

	if err := store.Clear(dir); err != nil {
		t.Fatalf("清除失败: %v", err)
	}
	view := store.Policy(dir)
	if view.PinnedCount != 0 {
		t.Fatalf("正文都没了，钉住标记必须一起清掉，实得 %d", view.PinnedCount)
	}
	if view.KeepPerKey != 30 {
		t.Fatalf("清除历史不该顺手把用户设的配额改回默认，实得 %d", view.KeepPerKey)
	}
}

func TestFactsReportsEffectiveQuotaAndPinnedCount(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	appendContents(t, store, dir, 0, 3)
	records := mustReadKey(t, store, dir, "conn-a", "public", "DEFAULT_GROUP", "app.yml", 0)
	if _, err := store.SetPinned(dir, refFor(records[0].Hash), true); err != nil {
		t.Fatalf("钉住失败: %v", err)
	}
	if _, err := store.SetPolicyKeepPerKey(dir, 40); err != nil {
		t.Fatalf("保存配额失败: %v", err)
	}

	facts := store.GetFacts(dir)
	if facts.KeepPerKey != 40 || facts.KeepSource != KeepSourcePolicy {
		t.Fatalf("体量事实必须回生效配额与来源档，实得 %+v", facts)
	}
	if facts.PinnedCount != 1 {
		t.Fatalf("钉住条数要如实，实得 %d", facts.PinnedCount)
	}

	view := store.Policy(dir)
	if view.UnpinnedOverQuota != 0 {
		t.Fatalf("未超配额时不该报多余条数，实得 %d", view.UnpinnedOverQuota)
	}
	// 把配额压到区间下界：3 条未钉住 2 条（钉住那条不计），超出 2 条。
	if _, err := store.SetPolicyKeepPerKey(dir, MinKeepPerKey); err != nil {
		t.Fatalf("保存配额失败: %v", err)
	}
	// 再攒到超配额：12 条未钉住 + 1 条钉住，阈值 10 ⇒ 超 2（锚点那条本身也在未钉住里，不参与删除）。
	appendContents(t, store, dir, 3, 13)
	over := store.Policy(dir).UnpinnedOverQuota
	if over <= 0 {
		t.Fatalf("超出新上限时必须如实数出可清理的条数，实得 %d", over)
	}
}

func TestPinsSurviveStoreRestart(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	appendContents(t, store, dir, 0, 13)
	records := mustReadKey(t, store, dir, "conn-a", "public", "DEFAULT_GROUP", "app.yml", 0)
	// records[11] 是「倒数第二旧」那一版：不钉它，配额 10 + 锚点会把它删掉。
	if _, err := store.SetPinned(dir, refFor(records[11].Hash), true); err != nil {
		t.Fatalf("钉住失败: %v", err)
	}
	if _, err := store.SetPolicyKeepPerKey(dir, MinKeepPerKey); err != nil {
		t.Fatalf("保存配额失败: %v", err)
	}

	// 换一份 Store（等价于重启进程）：判据必须仍然来自磁盘，而不是内存里的加速器。
	restarted := NewStore()
	removed, err := restarted.Prune(dir)
	if err != nil {
		t.Fatalf("裁剪失败: %v", err)
	}
	left := mustReadKey(t, restarted, dir, "conn-a", "public", "DEFAULT_GROUP", "app.yml", 0)
	if len(left) != MinKeepPerKey+2 {
		t.Fatalf("重启后钉住仍须豁免裁剪：应剩「锚点 + 最近 %d 未钉住 + 1 钉住」= %d，实得 %d（删了 %d）",
			MinKeepPerKey, MinKeepPerKey+2, len(left), removed)
	}
	for _, rec := range left {
		if rec.Hash == records[11].Hash {
			return
		}
	}
	t.Fatal("重启后钉住的那一版被裁掉了")
}

func loadPolicyOrDefault(t *testing.T, dir string) map[string]bool {
	t.Helper()
	policy, _ := loadPolicy(dir)
	return policy.pinnedSet()
}
