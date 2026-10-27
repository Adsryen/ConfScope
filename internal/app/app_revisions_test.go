package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"confscope/internal/portabledata"
	"confscope/internal/revisions"
)

// revisionsInput 造一条最小的观测记录：绑定层不许改这些事实字段。
func revisionsInput(content string) revisions.Input {
	return revisions.Input{
		Kind:         revisions.KindObserved,
		ConnectionID: "conn-retest",
		Provider:     "nacos",
		Namespace:    "public",
		Group:        "DEFAULT_GROUP",
		DataID:       "svc-gateway.yaml",
		Content:      content,
		Format:       "yaml",
	}
}

func TestAppendConfigRevisionWritesUnderAppData(t *testing.T) {
	root := t.TempDir()
	t.Setenv(portabledata.DataDirEnvName, root)

	a := &App{}
	res, err := a.AppendConfigRevision(revisionsInput("gateway: on\n"))
	if err != nil {
		t.Fatalf("绑定追加失败: %v", err)
	}
	if !res.Appended {
		t.Fatalf("首次必须写盘，reason=%q", res.Reason)
	}
	want := filepath.Join(root, portabledata.AppDataDirName, revisions.TrailFileName)
	if _, err := os.Stat(want); err != nil {
		t.Fatalf("版本历史必须落在 <数据根>/app-data/ 下（随主数据文件同处，换根整目录迁移自动带走）: %v", err)
	}

	// appVersion 由 Go 侧补齐：前端不传也不许留空，否则日后无法区分是哪个版本记的
	if !strings.EqualFold(res.Record.AppVersion, appVersion) && res.Record.AppVersion == "" {
		t.Fatalf("appVersion 要由绑定层补上，实得 %q", res.Record.AppVersion)
	}
}

func TestAppendConfigRevisionDoesNotTrustClientVersion(t *testing.T) {
	root := t.TempDir()
	t.Setenv(portabledata.DataDirEnvName, root)

	a := &App{}
	in := revisionsInput("a: 1\n")
	in.AppVersion = "client-claimed-9.9.9"
	res, err := a.AppendConfigRevision(in)
	if err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	if res.Record.AppVersion != "client-claimed-9.9.9" {
		t.Fatalf("前端显式给的值不该被改写，实得 %q", res.Record.AppVersion)
	}

	// 前端没给才补 Go 侧注入的版本号
	blank := revisionsInput("b: 2\n")
	blank.DataID = "other.yaml"
	resBlank, err := a.AppendConfigRevision(blank)
	if err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	if resBlank.Record.AppVersion != appVersion {
		t.Fatalf("缺 appVersion 时必须补构建注入值，实得 %q 期望 %q", resBlank.Record.AppVersion, appVersion)
	}
}

func TestAppendConfigRevisionRejectsNonServerTruth(t *testing.T) {
	root := t.TempDir()
	t.Setenv(portabledata.DataDirEnvName, root)

	a := &App{}
	// 编辑态草稿 / dry-run 预览从未被发布过，记进历史就是伪造版本（R5）
	for _, kind := range []string{"draft", "dry-run", "", "预览"} {
		in := revisionsInput("a: 1\n")
		in.Kind = kind
		if _, err := a.AppendConfigRevision(in); err == nil {
			t.Fatalf("kind=%q 必须被绑定层拒绝", kind)
		}
	}
	if got := mustReadAll(t, a, 0); len(got) != 0 {
		t.Fatalf("被拒绝的记录不得留下痕迹，实得 %d 条", len(got))
	}
}

func TestReadConfigRevisionsReturnsEmptySliceNotNull(t *testing.T) {
	root := t.TempDir()
	t.Setenv(portabledata.DataDirEnvName, root)

	a := &App{}
	// Wails 把 nil 序列化成 null，前端直接 .map() 就炸；两个读出口都必须给空数组
	all := mustReadAll(t, a, 0)
	if all == nil {
		t.Fatal("ReadConfigRevisions 空历史必须返回空切片")
	}
	keyed := mustReadKey(t, a, "conn-retest", "public", "DEFAULT_GROUP", "svc-gateway.yaml", 0)
	if keyed == nil {
		t.Fatal("ReadConfigRevisionsForKey 空历史必须返回空切片")
	}
	if len(all) != 0 || len(keyed) != 0 {
		t.Fatalf("空目录不该读出东西，实得 %d / %d", len(all), len(keyed))
	}

	if _, err := a.AppendConfigRevision(revisionsInput("a: 1\n")); err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	if got := mustReadAll(t, a, 0); len(got) != 1 {
		t.Fatalf("读回应当 1 条，实得 %d", len(got))
	}
}

func TestConfigRevisionFactsAndClear(t *testing.T) {
	root := t.TempDir()
	t.Setenv(portabledata.DataDirEnvName, root)

	a := &App{}
	fresh := a.GetConfigRevisionFacts()
	if fresh.Exists {
		t.Fatalf("没写过就谎报存在，设置页会显示一条不存在的历史")
	}

	for _, dataID := range []string{"a.yaml", "b.yaml"} {
		in := revisionsInput("k: v\n")
		in.DataID = dataID
		if _, err := a.AppendConfigRevision(in); err != nil {
			t.Fatalf("追加失败: %v", err)
		}
	}
	facts := a.GetConfigRevisionFacts()
	if !facts.Exists || facts.Records != 2 || facts.Keys != 2 {
		t.Fatalf("体量事实要说实话，实得 %+v", facts)
	}
	if facts.KeepPerKey <= 0 {
		t.Fatalf("保留策略要如实给出，实得 %d", facts.KeepPerKey)
	}

	// 清除是用户数据入口，不是「清理缓存」：清完必须真读不到，路径仍可继续追加
	if err := a.ClearConfigRevisions(); err != nil {
		t.Fatalf("清除失败: %v", err)
	}
	if got := mustReadAll(t, a, 0); len(got) != 0 {
		t.Fatalf("清除后仍读出 %d 条", len(got))
	}
	if after := a.GetConfigRevisionFacts(); after.Records != 0 {
		t.Fatalf("清除后事实没跟上，实得 %+v", after)
	}
	if _, err := a.AppendConfigRevision(revisionsInput("a: 1\n")); err != nil {
		t.Fatalf("清除后应能继续记录: %v", err)
	}
}

func TestPruneConfigRevisionThroughBinding(t *testing.T) {
	root := t.TempDir()
	t.Setenv(portabledata.DataDirEnvName, root)

	a := &App{}
	const keep = 10 // 合法区间下界：配额不再是随便一个入参，见 clampKeepPerKey 的唯一钳制点
	for i := 0; i < 22; i++ {
		in := revisionsInput("x\n")
		in.Content = strings.Repeat("x", i+1) + "\n"
		if _, err := a.AppendConfigRevision(in); err != nil {
			t.Fatalf("追加第 %d 条失败: %v", i, err)
		}
	}
	// 绑定层不收配额参数：改配额走 SaveConfigRevisionPolicy，清理走生效策略
	view, err := a.SaveConfigRevisionPolicy(keep)
	if err != nil {
		t.Fatalf("保存配额失败: %v", err)
	}
	if view.KeepPerKey != keep {
		t.Fatalf("保存后必须回读到生效值，实得 %d", view.KeepPerKey)
	}
	removed, err := a.PruneConfigRevisions()
	if err != nil {
		t.Fatalf("裁剪失败: %v", err)
	}
	// 22 版留「最早锚点 + 最近 10 版」= 保 11 删 11
	if removed != 11 {
		t.Fatalf("22 条保留 10 条 + 1 锚点应当删 11 条，实得 %d", removed)
	}
	records := mustReadKey(t, a, "conn-retest", "public", "DEFAULT_GROUP", "svc-gateway.yaml", 0)
	if len(records) != 11 {
		t.Fatalf("剩最早锚点 + 最近 10 版，实得 %d 条", len(records))
	}
	// 同一策略再裁一次必须删不动（幂等），也不许把已经在上限内的历史裁空
	again, err := a.PruneConfigRevisions()
	if err != nil {
		t.Fatalf("第二次裁剪失败: %v", err)
	}
	if again != 0 {
		t.Fatalf("未超配额时不得再删条目，实得 %d", again)
	}
	if still := mustReadAll(t, a, 0); len(still) != 11 {
		t.Fatalf("第二次裁剪不该删掉东西，实得 %d", len(still))
	}
}

// mustReadAll / mustReadKey 消除绑定层测试样板：读出口现在带 error，读失败要立刻打停。
func mustReadAll(t *testing.T, a *App, limit int) []revisions.Record {
	t.Helper()
	records, err := a.ReadConfigRevisions(limit)
	if err != nil {
		t.Fatalf("ReadConfigRevisions 失败: %v", err)
	}
	return records
}

func mustReadKey(t *testing.T, a *App, connectionID, namespace, group, dataID string, limit int) []revisions.Record {
	t.Helper()
	records, err := a.ReadConfigRevisionsForKey(connectionID, namespace, group, dataID, limit)
	if err != nil {
		t.Fatalf("ReadConfigRevisionsForKey 失败: %v", err)
	}
	return records
}

// 轮67 R57-WP15：绑定层必须把「读不出来」如实抛给前端。
//
// 前端界面要能在「本机还没记过」与「这份日志读不出来」之间说实话（配置浏览的历史面板据此
// 决定是显示空态还是显示带复制键的错误）。老实现回 nil，Wails 序列化成空数组，
// 界面只能说一句假话——而且正好在数据最可疑的时候说。
func TestReadConfigRevisionsSurfacesUnreadableTrail(t *testing.T) {
	root := t.TempDir()
	t.Setenv(portabledata.DataDirEnvName, root)

	app := &App{}

	// 文件还没生成：合法的空历史，不是错误。
	first, err := app.ReadConfigRevisionsForKey("conn-retest", "public", "DEFAULT_GROUP", "svc-gateway.yaml", 0)
	if err != nil {
		t.Fatalf("文件不存在不该算读失败: %v", err)
	}
	if len(first) != 0 {
		t.Fatalf("应当读到 0 条，实得 %d", len(first))
	}

	// 同名位置被目录占据：整份日志读不出来，两个读出口都必须报错。
	appData := filepath.Join(root, portabledata.AppDataDirName)
	if err := os.MkdirAll(filepath.Join(appData, revisions.TrailFileName), 0o755); err != nil {
		t.Fatalf("造阻塞项失败: %v", err)
	}
	if _, err := app.ReadConfigRevisionsForKey("conn-retest", "public", "DEFAULT_GROUP", "svc-gateway.yaml", 0); err == nil {
		t.Fatal("按键读出口把失败吞成了空数组")
	}
	if _, err := app.ReadConfigRevisions(0); err == nil {
		t.Fatal("全站读出口同样把失败吞成了空数组")
	}

	// 清除同样不许假装成功：文件动不了就得说清楚，否则用户以为历史已经没了。
	if err := app.ClearConfigRevisions(); err == nil {
		t.Fatal("目标不可写时清除必须报错")
	}
}

// ---- 轮99：配额可调 + 版本可钉住（绑定层的出入口） ----

// revisionRefFor 把绑定入参摊成一条钉住（与界面传的四个归属字段 + 摘要同形状）。
func revisionRefFor(hash string) revisions.PinnedRef {
	return revisions.PinnedRef{ConnectionID: "conn-retest", Namespace: "public", Group: "DEFAULT_GROUP", DataID: "svc-gateway.yaml", Hash: hash}
}

func TestGetConfigRevisionPolicyReportsRangeAndSource(t *testing.T) {
	root := t.TempDir()
	t.Setenv(portabledata.DataDirEnvName, root)

	a := &App{}
	view, err := a.GetConfigRevisionPolicy()
	if err != nil {
		t.Fatalf("读策略失败: %v", err)
	}
	// 区间与默认值由这里回给界面：前端自己抄一份常量就是第二个判据源。
	if view.MinKeepPerKey != revisions.MinKeepPerKey || view.MaxKeepPerKey != revisions.MaxKeepPerKey {
		t.Fatalf("合法区间必须如实回传，实得 %d~%d", view.MinKeepPerKey, view.MaxKeepPerKey)
	}
	if view.KeepPerKey != revisions.DefaultKeepPerKey || view.KeepSource != revisions.KeepSourceMissing {
		t.Fatalf("没设过策略要说「回落默认」而不是「用户设成 50」，实得 %+v", view)
	}
	if view.Pinned == nil {
		t.Fatal("钉住清单必须回空数组而不是 null：Wails 把 null 送进 .length 就是白屏")
	}
	if view.Path != filepath.Join(root, portabledata.AppDataDirName, revisions.PolicyFileName) {
		t.Fatalf("策略文件要落在 app-data 下（换根整目录搬运才带得走），实得 %q", view.Path)
	}
}

func TestSaveConfigRevisionPolicyClampsAndReportsTruth(t *testing.T) {
	root := t.TempDir()
	t.Setenv(portabledata.DataDirEnvName, root)

	a := &App{}
	view, err := a.SaveConfigRevisionPolicy(revisions.MaxKeepPerKey + 1)
	if err != nil {
		t.Fatalf("越界保存必须钳而不是报错: %v", err)
	}
	if view.KeepPerKey != revisions.DefaultKeepPerKey {
		t.Fatalf("越界入参应钳到默认档，实得 %d", view.KeepPerKey)
	}
	if view.KeepSource != revisions.KeepSourceOutOfRange {
		t.Fatalf("回落必须如实上报档位，实得 %q", view.KeepSource)
	}
	// 存盘不删历史：先攒 3 版，把配额压到区间下界，条数一条都不许少。
	for i := 0; i < 3; i++ {
		if _, err := a.AppendConfigRevision(revisionsInput(strings.Repeat("x", i+1) + "\n")); err != nil {
			t.Fatalf("追加失败: %v", err)
		}
	}
	lowered, err := a.SaveConfigRevisionPolicy(revisions.MinKeepPerKey)
	if err != nil {
		t.Fatalf("保存失败: %v", err)
	}
	if got := len(mustReadAll(t, a, 0)); got != 3 {
		t.Fatalf("改配额不该顺手删用户数据，实得 %d 条", got)
	}
	if lowered.UnpinnedOverQuota < 0 {
		t.Fatalf("超出新上限的条数不许报负数，实得 %d", lowered.UnpinnedOverQuota)
	}
}

func TestSetConfigRevisionPinnedThroughBinding(t *testing.T) {
	root := t.TempDir()
	t.Setenv(portabledata.DataDirEnvName, root)

	a := &App{}
	for i := 0; i < 13; i++ {
		in := revisionsInput("x\n")
		in.Content = fmt.Sprintf("v%d: %d\n", i, i)
		if _, err := a.AppendConfigRevision(in); err != nil {
			t.Fatalf("追加失败: %v", err)
		}
	}
	records := mustReadKey(t, a, "conn-retest", "public", "DEFAULT_GROUP", "svc-gateway.yaml", 0)
	target := records[11]

	res, err := a.SetConfigRevisionPinned("conn-retest", "public", "DEFAULT_GROUP", "svc-gateway.yaml", target.Hash, true)
	if err != nil {
		t.Fatalf("钉住失败: %v", err)
	}
	if !res.Pinned || res.Hits != 1 {
		t.Fatalf("钉住结果不实，实得 %+v", res)
	}
	if _, err := a.SaveConfigRevisionPolicy(revisions.MinKeepPerKey); err != nil {
		t.Fatalf("改配额失败: %v", err)
	}
	if _, err := a.PruneConfigRevisions(); err != nil {
		t.Fatalf("裁剪失败: %v", err)
	}
	left := mustReadKey(t, a, "conn-retest", "public", "DEFAULT_GROUP", "svc-gateway.yaml", 0)
	if len(left) != revisions.MinKeepPerKey+2 {
		t.Fatalf("应剩「锚点 + 最近 10 未钉住 + 1 钉住」，实得 %d", len(left))
	}
	survived := false
	for _, rec := range left {
		if rec.Hash == target.Hash {
			survived = true
		}
	}
	if !survived {
		t.Fatal("绑定层裁掉了用户钉住的那一版")
	}

	view, err := a.GetConfigRevisionPolicy()
	if err != nil {
		t.Fatalf("读策略失败: %v", err)
	}
	if view.PinnedCount != 1 {
		t.Fatalf("钉住条数要如实，实得 %d", view.PinnedCount)
	}
	if facts := a.GetConfigRevisionFacts(); facts.PinnedCount != 1 || facts.KeepSource != revisions.KeepSourcePolicy {
		t.Fatalf("体量事实必须带上钉住数与配额来源档，实得 %+v", facts)
	}

	// 取消钉住走同一颗绑定的 false 分支
	off, err := a.SetConfigRevisionPinned("conn-retest", "public", "DEFAULT_GROUP", "svc-gateway.yaml", target.Hash, false)
	if err != nil {
		t.Fatalf("取消钉住失败: %v", err)
	}
	if off.Pinned || off.PinnedCount != 0 {
		t.Fatalf("取消后清单应为空，实得 %+v", off)
	}
}

func TestSetConfigRevisionPinnedSaysWhenNothingToPin(t *testing.T) {
	root := t.TempDir()
	t.Setenv(portabledata.DataDirEnvName, root)

	a := &App{}
	// 本机一条都没记过：钉住不是错误，但必须如实回「钉住 0 条」。
	res, err := a.SetConfigRevisionPinned("conn-retest", "public", "DEFAULT_GROUP", "svc-gateway.yaml", "sha256:never-seen", true)
	if err != nil {
		t.Fatalf("钉不住不该报错: %v", err)
	}
	if res.Pinned || res.Hits != 0 {
		t.Fatalf("必须如实回 hits=0，实得 %+v", res)
	}
	// 归属缺失是调用方的错，要报出来（否则界面点了没反应还没人知道为什么）。
	if _, err := a.SetConfigRevisionPinned("", "public", "DEFAULT_GROUP", "svc-gateway.yaml", "sha256:1", true); err == nil {
		t.Fatal("缺少连接标识时必须报错")
	}
}

func TestClearConfigRevisionsKeepsQuotaButDropsPins(t *testing.T) {
	root := t.TempDir()
	t.Setenv(portabledata.DataDirEnvName, root)

	a := &App{}
	if _, err := a.AppendConfigRevision(revisionsInput("a: 1\n")); err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	records := mustReadKey(t, a, "conn-retest", "public", "DEFAULT_GROUP", "svc-gateway.yaml", 0)
	if _, err := a.SaveConfigRevisionPolicy(40); err != nil {
		t.Fatalf("改配额失败: %v", err)
	}
	if _, err := a.SetConfigRevisionPinned("conn-retest", "public", "DEFAULT_GROUP", "svc-gateway.yaml", records[0].Hash, true); err != nil {
		t.Fatalf("钉住失败: %v", err)
	}
	if err := a.ClearConfigRevisions(); err != nil {
		t.Fatalf("清除失败: %v", err)
	}
	view, err := a.GetConfigRevisionPolicy()
	if err != nil {
		t.Fatalf("读策略失败: %v", err)
	}
	if view.PinnedCount != 0 {
		t.Fatalf("清完正文还留着钉住，界面会亮一排点不到的标记，实得 %d", view.PinnedCount)
	}
	if view.KeepPerKey != 40 {
		t.Fatalf("清除历史不该把用户设的配额一起改掉，实得 %d", view.KeepPerKey)
	}
}
