package app

import (
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
	for i := 0; i < 8; i++ {
		in := revisionsInput("x\n")
		in.Content = strings.Repeat("x", i+1) + "\n"
		if _, err := a.AppendConfigRevision(in); err != nil {
			t.Fatalf("追加第 %d 条失败: %v", i, err)
		}
	}
	removed, err := a.PruneConfigRevisions(3)
	if err != nil {
		t.Fatalf("裁剪失败: %v", err)
	}
	// 8 版留「最早锚点 + 最近 3 版」= 保 4 删 4
	if removed != 4 {
		t.Fatalf("8 条保留 3 条 + 1 锚点应当删 4 条，实得 %d", removed)
	}
	records := mustReadKey(t, a, "conn-retest", "public", "DEFAULT_GROUP", "svc-gateway.yaml", 0)
	if len(records) != 4 {
		t.Fatalf("剩最早锚点 + 最近 3 版，实得 %d 条", len(records))
	}
	// keepPerKey<=0 走默认策略，不得把历史裁空
	if _, err := a.PruneConfigRevisions(0); err != nil {
		t.Fatalf("默认裁剪失败: %v", err)
	}
	if still := mustReadAll(t, a, 0); len(still) != 4 {
		t.Fatalf("默认策略不该删掉未超配额的记录，实得 %d", len(still))
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
