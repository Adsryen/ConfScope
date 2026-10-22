package portabledata

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func seedRoot(t *testing.T, root string) map[string]string {
	t.Helper()
	files := map[string]string{
		filepath.Join(AppDataDirName, AppDataDocFileName):                                  `{"schemaVersion":2,"savedAt":"2026-10-22T01:00:00Z","data":{"connections":[]}}`,
		filepath.Join(SnapshotDirName, "snap_1", "metadata.json"):                          `{"id":"snap_1"}`,
		filepath.Join(WebviewDirName, "Default", "Local Storage", "leveldb", "000003.log"): "local-storage",
		filepath.Join(AppDataRecoveryPointDirName, "recovery.csbackup"):                    "encrypted-backup",
		"audit-trail.jsonl": `{"event":"a"}` + "\n",
	}
	for rel, content := range files {
		path := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("MkdirAll %s: %v", rel, err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("WriteFile %s: %v", rel, err)
		}
	}
	return files
}

func migrationStub(t *testing.T) (stubLayout, string, string) {
	t.Helper()
	exeDir := t.TempDir()
	pointerDir := t.TempDir()
	return stubLayout{pointerDir: pointerDir, osDataDir: filepath.Join(t.TempDir(), "os")}, filepath.Join(exeDir, DataDirName), pointerDir
}

func readPointerFile(t *testing.T, pointerDir string) DataRootPointer {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(pointerDir, PointerFileName))
	if err != nil {
		t.Fatalf("ReadFile pointer: %v", err)
	}
	var ptr DataRootPointer
	if err := json.Unmarshal(raw, &ptr); err != nil {
		t.Fatalf("Unmarshal pointer: %v", err)
	}
	return ptr
}

func TestPlanDataRootMigrationRejectsUnsafeTargets(t *testing.T) {
	stub, source, _ := migrationStub(t)
	seedRoot(t, source)
	exePath := filepath.Join(filepath.Dir(source), "ConfScope")
	ctx := stub.context(exePath)

	nested := filepath.Join(source, "inside")

	cases := []struct {
		name   string
		target string
		want   string
	}{
		{"空路径", "  ", "请先选择目标目录"},
		{"相对路径", "relative/data", "绝对路径"},
		{"与当前根相同", source, "相同"},
		{"目标在源内部", nested, "不能在当前数据根内部"},
	}
	for _, testCase := range cases {
		plan := planDataRootMigration(testCase.target, ctx)
		if plan.Valid {
			t.Fatalf("%s：plan.Valid = true, want false", testCase.name)
		}
		if !strings.Contains(plan.Error, testCase.want) {
			t.Fatalf("%s：error = %q, want 含 %q", testCase.name, plan.Error, testCase.want)
		}
	}

	// 源落在目标内部
	plan := planDataRootMigration(filepath.Dir(source), ctx)
	if plan.Valid || !strings.Contains(plan.Error, "自我包含") {
		t.Fatalf("源在目标内部必须被拒，error = %q", plan.Error)
	}

	// 目标已有另一份数据
	otherRoot := filepath.Join(t.TempDir(), "other")
	writeMainDataDoc(t, otherRoot)
	plan = planDataRootMigration(otherRoot, ctx)
	if plan.Valid || !strings.Contains(plan.Error, "另一份") {
		t.Fatalf("目标已有数据必须被拒，error = %q", plan.Error)
	}

	// 目标已有同名条目（不是 ConfScope 数据，但会互相覆盖）
	occupied := t.TempDir()
	if err := os.WriteFile(filepath.Join(occupied, AppDataDirName), []byte("x"), 0o644); err != nil {
		t.Fatalf("WriteFile 冲突条目: %v", err)
	}
	plan = planDataRootMigration(occupied, ctx)
	if plan.Valid || !strings.Contains(plan.Error, "同名条目") {
		t.Fatalf("同名冲突必须被拒，error = %q", plan.Error)
	}

	// 不可写目标
	roParent := t.TempDir()
	target := filepath.Join(roParent, "data")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatalf("MkdirAll target: %v", err)
	}
	if err := os.Chmod(target, 0o555); err != nil {
		t.Fatalf("Chmod: %v", err)
	}
	ResetWritableProbeCacheForTest()
	if probeWritable(target) {
		t.Fatalf("测试前置条件失败：chmod 0555 后仍判可写")
	}
	blocked := stub
	blocked.unwritable = map[string]bool{target: true}
	plan = planDataRootMigration(target, blocked.context(exePath))
	ResetWritableProbeCacheForTest()
	if plan.Valid || !strings.Contains(plan.Error, "不可写") {
		t.Fatalf("不可写目标必须被拒，error = %q", plan.Error)
	}

	// 用户主目录 / 盘根
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	if plan = planDataRootMigration(home, ctx); plan.Valid || !strings.Contains(plan.Error, "主目录") {
		t.Fatalf("主目录必须被拒，error = %q", plan.Error)
	}
	rootTarget := string(filepath.Separator)
	if plan = planDataRootMigration(rootTarget, ctx); plan.Valid || !strings.Contains(plan.Error, "磁盘根目录") {
		t.Fatalf("盘根必须被拒，error = %q", plan.Error)
	}

	if _, err := os.Stat(filepath.Join(stub.pointerDir, PointerFileName)); !os.IsNotExist(err) {
		t.Fatalf("预览不得写指针")
	}
}

func TestPlanDataRootMigrationBlocksDataInsideInstallDirectory(t *testing.T) {
	stub, source, _ := migrationStub(t)
	seedRoot(t, source)
	exeDir := filepath.Dir(source)
	if err := os.WriteFile(filepath.Join(exeDir, InstallMarkerFileName), []byte(`{"mode":"installed"}`), 0o644); err != nil {
		t.Fatalf("WriteFile marker: %v", err)
	}
	ctx := stub.context(filepath.Join(exeDir, "confscope"))
	plan := planDataRootMigration(filepath.Join(exeDir, "ConfScopeData-2"), ctx)
	if plan.Valid || !strings.Contains(plan.Error, "卸载会连数据一起删掉") {
		t.Fatalf("安装态把数据放安装目录必须被拒，error = %q", plan.Error)
	}
}

func TestMigrateDataRootCopiesFirstAndKeepsSourceIntact(t *testing.T) {
	stub, source, pointerDir := migrationStub(t)
	want := seedRoot(t, source)
	// 运行时契约文件不属于用户数据，不得被搬进新根
	if err := os.WriteFile(filepath.Join(source, PointerFileName), []byte("{}"), 0o644); err != nil {
		t.Fatalf("WriteFile pointer noise: %v", err)
	}
	exePath := filepath.Join(filepath.Dir(source), "ConfScope")
	ctx := stub.context(exePath)
	target := filepath.Join(t.TempDir(), "moved")

	plan := planDataRootMigration(target, ctx)
	if !plan.Valid {
		t.Fatalf("plan invalid: %s", plan.Error)
	}
	if plan.ItemCount != len(want) {
		t.Fatalf("plan.ItemCount = %d, want %d", plan.ItemCount, len(want))
	}
	if plan.TotalBytes <= 0 {
		t.Fatalf("plan.TotalBytes = %d, want > 0", plan.TotalBytes)
	}

	result, err := migrateDataRoot(target, ctx)
	if err != nil {
		t.Fatalf("migrateDataRoot: %v", err)
	}
	if !result.RequiresRestart || result.RestartReason == "" {
		t.Fatalf("换根必须要求重启，result = %+v", result)
	}
	if result.ItemsCopied != len(want) || result.ItemsReused != 0 {
		t.Fatalf("copied/reused = %d/%d, want %d/0", result.ItemsCopied, result.ItemsReused, len(want))
	}

	for rel, content := range want {
		raw, err := os.ReadFile(filepath.Join(result.Target, rel))
		if err != nil {
			t.Fatalf("ReadFile 迁移结果 %s: %v", rel, err)
		}
		if string(raw) != content {
			t.Fatalf("迁移内容不一致 %s", rel)
		}
	}
	if _, err := os.Stat(filepath.Join(result.Target, PointerFileName)); !os.IsNotExist(err) {
		t.Fatalf("指针文件不得被当作用户数据拷进新根")
	}
	if _, err := os.Stat(filepath.Join(result.Target, MigrationJournalFileName)); !os.IsNotExist(err) {
		t.Fatalf("迁移成功后必须清理断点记录")
	}

	// 旧根一个文件都不能少，只多一个 MIGRATED 标记
	for rel := range want {
		if _, err := os.Stat(filepath.Join(source, rel)); err != nil {
			t.Fatalf("旧根数据被删了 %s: %v", rel, err)
		}
	}
	entries, err := os.ReadDir(source)
	if err != nil {
		t.Fatalf("ReadDir source: %v", err)
	}
	markerCount := 0
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), MigratedMarkerPrefix) {
			markerCount++
		}
	}
	if markerCount != 1 {
		t.Fatalf("旧根必须有且只有 1 个迁移标记，实际 %d", markerCount)
	}

	ptr := readPointerFile(t, pointerDir)
	if filepath.Clean(ptr.DataRoot) != filepath.Clean(target) {
		t.Fatalf("pointer.dataRoot = %q, want %q", ptr.DataRoot, target)
	}
	if filepath.Clean(ptr.PreviousRoot) != filepath.Clean(source) {
		t.Fatalf("pointer.previousRoot = %q, want %q", ptr.PreviousRoot, source)
	}
	// 解析链必须立刻认新根（不缓存），且档位是 user-choice
	layout, err := ctx.layout()
	if err != nil {
		t.Fatalf("LayoutFor: %v", err)
	}
	if layout.Source != RootSourceUserChoice || filepath.Clean(layout.DataRoot) != filepath.Clean(target) {
		t.Fatalf("layout = %+v, want user-choice + 新根", layout)
	}
}

func TestMigrateDataRootIsResumableAndIdempotent(t *testing.T) {
	stub, source, pointerDir := migrationStub(t)
	want := seedRoot(t, source)
	ctx := stub.context(filepath.Join(filepath.Dir(source), "ConfScope"))
	target := filepath.Join(t.TempDir(), "moved")

	// 模拟上次中断：第一个文件已按同样内容拷过去并留了断点记录
	var rels []string
	for rel := range want {
		rels = append(rels, rel)
	}
	sort.Strings(rels)
	digests := map[string]string{}
	for _, rel := range rels[:2] {
		path := filepath.Join(source, rel)
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("ReadFile source %s: %v", rel, err)
		}
		if err := os.MkdirAll(filepath.Join(target, filepath.Dir(rel)), 0o755); err != nil {
			t.Fatalf("MkdirAll target: %v", err)
		}
		if err := os.WriteFile(filepath.Join(target, rel), raw, 0o644); err != nil {
			t.Fatalf("WriteFile target: %v", err)
		}
		sum, _, err := fileDigest(path)
		if err != nil {
			t.Fatalf("fileDigest: %v", err)
		}
		digests[rel] = sum
	}
	journal := migrationJournal{Source: source, Target: target, Copied: digests}
	if err := saveMigrationJournal(filepath.Join(target, MigrationJournalFileName), &journal); err != nil {
		t.Fatalf("saveMigrationJournal: %v", err)
	}

	plan := planDataRootMigration(target, ctx)
	if !plan.Resumable || plan.ReusedItems != 2 {
		t.Fatalf("plan 必须识别断点，resumable=%v reused=%d", plan.Resumable, plan.ReusedItems)
	}

	result, err := migrateDataRoot(target, ctx)
	if err != nil {
		t.Fatalf("migrateDataRoot 续跑: %v", err)
	}
	if result.ItemsReused != 2 {
		t.Fatalf("ItemsReused = %d, want 2", result.ItemsReused)
	}
	if result.ItemsCopied != len(want)-2 {
		t.Fatalf("ItemsCopied = %d, want %d", result.ItemsCopied, len(want)-2)
	}

	// 二次调用：目标已生效为数据根，必须原地拒绝而不是重复拷
	if _, err := migrateDataRoot(target, ctx); err == nil {
		t.Fatalf("重复迁往已生效的根必须被拒")
	}
	for rel, content := range want {
		raw, err := os.ReadFile(filepath.Join(target, rel))
		if err != nil || string(raw) != content {
			t.Fatalf("续跑后内容不一致 %s: %v", rel, err)
		}
	}
	if _, err := os.Stat(filepath.Join(target, MigrationJournalFileName)); !os.IsNotExist(err) {
		t.Fatalf("二次成功后断点记录必须清理")
	}
	ptr := readPointerFile(t, pointerDir)
	if filepath.Clean(ptr.PreviousRoot) != filepath.Clean(source) {
		t.Fatalf("续跑不得改写 previousRoot = %q", ptr.PreviousRoot)
	}
}

func TestMigrateDataRootFailureLeavesPartialCopiesCleaned(t *testing.T) {
	stub, source, pointerDir := migrationStub(t)
	want := seedRoot(t, source)
	ctx := stub.context(filepath.Join(filepath.Dir(source), "ConfScope"))
	target := filepath.Join(t.TempDir(), "moved")

	// 让排序后的第二个文件读不了：第一个已拷出去，必须被回滚删除
	var rels []string
	for rel := range want {
		rels = append(rels, rel)
	}
	sort.Strings(rels)
	blocked := filepath.Join(source, rels[1])
	if err := os.Chmod(blocked, 0o000); err != nil {
		t.Fatalf("Chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(blocked, 0o644) })

	_, err := migrateDataRoot(target, ctx)
	if err == nil {
		t.Fatalf("migrateDataRoot 必须失败")
	}
	if _, err := os.Stat(filepath.Join(target, rels[0])); !os.IsNotExist(err) {
		t.Fatalf("失败后必须删掉本次自己拷的文件，实际残留 %s", rels[0])
	}
	if _, err := os.Stat(filepath.Join(target, MigrationJournalFileName)); err != nil {
		t.Fatalf("断点记录必须保留供续跑: %v", err)
	}
	if _, err := os.Stat(filepath.Join(stub.pointerDir, PointerFileName)); !os.IsNotExist(err) {
		t.Fatalf("迁移失败不得写指针")
	}
	for _, rel := range rels {
		if _, err := os.Stat(filepath.Join(source, rel)); err != nil {
			t.Fatalf("失败不得动源目录 %s: %v", rel, err)
		}
	}
	if pointerDir != "" {
		if _, err := os.Stat(filepath.Join(pointerDir, PointerFileName)); !os.IsNotExist(err) {
			t.Fatalf("失败不得写指针")
		}
	}
}

func TestCheckDataRootRollbackAndRollback(t *testing.T) {
	stub, source, pointerDir := migrationStub(t)
	seedRoot(t, source)
	ctx := stub.context(filepath.Join(filepath.Dir(source), "ConfScope"))
	target := filepath.Join(t.TempDir(), "moved")
	if _, err := migrateDataRoot(target, ctx); err != nil {
		t.Fatalf("migrateDataRoot: %v", err)
	}

	status := checkDataRootRollback(ctx)
	if !status.Available {
		t.Fatalf("刚迁移完必须可回退，reason = %s", status.Reason)
	}
	if filepath.Clean(status.PreviousRoot) != filepath.Clean(source) {
		t.Fatalf("status.PreviousRoot = %q, want %q", status.PreviousRoot, source)
	}
	if !status.CurrentDoc.Exists || !status.PreviousDoc.Exists {
		t.Fatalf("确认文案需要两侧主数据信息，got %+v", status)
	}
	if status.PreviousDoc.SavedAt == "" {
		t.Fatalf("savedAt 必须读出，供用户判断回退会不会丢改动")
	}

	result, err := rollbackDataRoot(ctx)
	if err != nil {
		t.Fatalf("rollbackDataRoot: %v", err)
	}
	if filepath.Clean(result.Target) != filepath.Clean(source) {
		t.Fatalf("回退目标 = %q, want %q", result.Target, source)
	}
	ptr := readPointerFile(t, pointerDir)
	if filepath.Clean(ptr.DataRoot) != filepath.Clean(source) {
		t.Fatalf("回退后指针 = %q, want 旧根", ptr.DataRoot)
	}
	layout, err := ctx.layout()
	if err != nil {
		t.Fatalf("LayoutFor: %v", err)
	}
	if filepath.Clean(layout.DataRoot) != filepath.Clean(source) {
		t.Fatalf("回退后解析根 = %q, want 旧根", layout.DataRoot)
	}
	for _, dir := range []string{target, source} {
		if !hasMainDataFile(dir) {
			t.Fatalf("回退只改指针，两侧数据都必须完好：%s", dir)
		}
	}

	// 没有 previousRoot 时无处可退
	fresh := stubLayout{pointerDir: t.TempDir(), osDataDir: filepath.Join(t.TempDir(), "os")}
	freshStatus := checkDataRootRollback(fresh.context(filepath.Join(t.TempDir(), "ConfScope")))
	if freshStatus.Available || freshStatus.Reason == "" {
		t.Fatalf("无旧位置时不可回退，got %+v", freshStatus)
	}
}

func TestRollbackBlockedWhenOldRootLostItsDataDoc(t *testing.T) {
	stub, source, _ := migrationStub(t)
	seedRoot(t, source)
	ctx := stub.context(filepath.Join(filepath.Dir(source), "ConfScope"))
	target := filepath.Join(t.TempDir(), "moved")
	if _, err := migrateDataRoot(target, ctx); err != nil {
		t.Fatalf("migrateDataRoot: %v", err)
	}
	if err := os.Remove(MainDataDocPath(source)); err != nil {
		t.Fatalf("Remove 旧根主数据文件: %v", err)
	}
	status := checkDataRootRollback(ctx)
	if status.Available || !strings.Contains(status.Reason, "主数据文件") {
		t.Fatalf("旧根没有主数据文件时必须拒绝回退，got %+v", status)
	}
	if _, err := rollbackDataRoot(ctx); err == nil {
		t.Fatalf("rollbackDataRoot 必须失败")
	}
}

func TestPlanWarnsWhenEnvOverrideIsActive(t *testing.T) {
	exeDir := t.TempDir()
	envRoot := filepath.Join(t.TempDir(), "env-root")
	seedRoot(t, envRoot)
	stub := stubLayout{
		lookupEnv:  map[string]string{DataDirEnvName: envRoot},
		pointerDir: t.TempDir(),
		osDataDir:  filepath.Join(t.TempDir(), "os"),
	}
	plan := planDataRootMigration(filepath.Join(t.TempDir(), "moved"), stub.context(filepath.Join(exeDir, "ConfScope")))
	if !plan.Valid {
		t.Fatalf("plan invalid: %s", plan.Error)
	}
	if !strings.Contains(strings.Join(plan.Warnings, " | "), DataDirEnvName) {
		t.Fatalf("环境变量档必须警告，warnings = %v", plan.Warnings)
	}
}

func TestListMigrationItemsSkipsRuntimeNoise(t *testing.T) {
	root := t.TempDir()
	seedRoot(t, root)
	for _, noise := range []string{PointerFileName, InstallMarkerFileName, MigrationJournalFileName, MigratedMarkerFileName(1)} {
		if err := os.WriteFile(filepath.Join(root, noise), []byte("x"), 0o644); err != nil {
			t.Fatalf("WriteFile noise %s: %v", noise, err)
		}
	}
	files, _, err := listMigrationItems(root)
	if err != nil {
		t.Fatalf("listMigrationItems: %v", err)
	}
	joined := strings.Join(files, ",")
	for _, noise := range []string{PointerFileName, InstallMarkerFileName, MigrationJournalFileName, MigratedMarkerPrefix} {
		if strings.Contains(joined, noise) {
			t.Fatalf("运行时契约文件不得进迁移清单：%s in %s", noise, joined)
		}
	}
}
