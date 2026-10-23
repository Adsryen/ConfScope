package revisions

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func observedInput(content string) Input {
	return Input{
		Kind:           KindObserved,
		ConnectionID:   "conn-a",
		ConnectionName: "Retest Nacos A",
		Provider:       "nacos",
		Namespace:      "public",
		Group:          "DEFAULT_GROUP",
		DataID:         "app.yml",
		Content:        content,
		Format:         "yaml",
		AppVersion:     "1.9.7",
	}
}

func readLines(t *testing.T, dataDir string) []string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dataDir, TrailFileName))
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatalf("读文件失败: %v", err)
	}
	var out []string
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) != "" {
			out = append(out, line)
		}
	}
	return out
}

func TestAppendWritesOneLinePerChange(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()

	res, err := store.Append(dir, observedInput("server.port=8080\n"))
	if err != nil {
		t.Fatalf("首次追加不该报错: %v", err)
	}
	if !res.Appended {
		t.Fatalf("首次追加必须写盘，reason=%q", res.Reason)
	}
	if !strings.HasPrefix(res.Record.Hash, "sha256:") {
		t.Fatalf("摘要必须带算法前缀，实得 %q", res.Record.Hash)
	}
	if res.Record.Bytes != len("server.port=8080\n") {
		t.Fatalf("字节数要按规范化后的正文算，实得 %d", res.Record.Bytes)
	}
	if got := len(readLines(t, dir)); got != 1 {
		t.Fatalf("应当只有 1 行，实得 %d", got)
	}

	// 同一版反复读：幂等，不再写盘（R4 写放大上限）
	again, err := store.Append(dir, observedInput("server.port=8080\n"))
	if err != nil {
		t.Fatalf("重复追加不该报错: %v", err)
	}
	if again.Appended || again.Reason != ReasonDuplicate {
		t.Fatalf("同一摘要应当跳过，实得 appended=%v reason=%q", again.Appended, again.Reason)
	}
	if got := len(readLines(t, dir)); got != 1 {
		t.Fatalf("重复读取不得放大写入，行数实得 %d", got)
	}

	// 真的变了才记：一个空行也算变（不猜「看起来一样」）
	changed, err := store.Append(dir, observedInput("server.port=8080\n\n"))
	if err != nil {
		t.Fatalf("变更追加不该报错: %v", err)
	}
	if !changed.Appended {
		t.Fatalf("多一个空行必须判为新版")
	}
	if got := len(readLines(t, dir)); got != 2 {
		t.Fatalf("应当有 2 行，实得 %d", got)
	}
}

func TestNormalizeContentMakesCRLFAndLFSameVersion(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	if _, err := store.Append(dir, observedInput("a: 1\r\nb: 2\r\n")); err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	// 同一版在 Windows/Linux 读回来只差换行符：判成两版等于给用户造假历史
	res, err := store.Append(dir, observedInput("a: 1\nb: 2\n"))
	if err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	if res.Appended {
		t.Fatalf("换行符差异不得算作新版本，实得 appended=%v hash=%q", res.Appended, res.Record.Hash)
	}
	if res.Reason != ReasonDuplicate {
		t.Fatalf("应当判重，实得 reason=%q", res.Reason)
	}
	// 入库的是规范化后的正文，不是原样搬运（老版 Windows 正文里不该留着 \r）
	records := store.Read(dir, 0)
	if len(records) != 1 {
		t.Fatalf("应当只有 1 版，实得 %d", len(records))
	}
	if strings.Contains(records[0].Content, "\r") {
		t.Fatalf("入库正文必须已规范化换行，实得 %q", records[0].Content)
	}
	// 尾随换行是内容的一部分：少一个换行就是另一版，不许被规范化顺手抹掉
	trimmed, err := store.Append(dir, observedInput("a: 1\nb: 2"))
	if err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	if !trimmed.Appended {
		t.Fatalf("去掉尾随换行必须判为新版（规范化只管换行符种类）")
	}
}

func TestOversizedContentKeepsDigestOnly(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	big := strings.Repeat("x", MaxContentBytes+1)
	res, err := store.Append(dir, observedInput(big))
	if err != nil {
		t.Fatalf("超限正文也该留下一版记录: %v", err)
	}
	if !res.Appended {
		t.Fatalf("应当写盘")
	}
	if res.Record.Content != "" {
		t.Fatalf("超限不得缓存正文")
	}
	if res.Record.ContentOmitted != ContentOmittedTooLarge {
		t.Fatalf("必须如实标注未缓存，实得 %q", res.Record.ContentOmitted)
	}
	if res.Record.Bytes != len(big) {
		t.Fatalf("字节数要按真实大小记，实得 %d", res.Record.Bytes)
	}
	if res.Record.Hash == "" {
		t.Fatalf("未缓存正文也要有摘要，否则下一版无从判重")
	}
	lines := readLines(t, dir)
	if len(lines) != 1 {
		t.Fatalf("应当只有 1 行，实得 %d", len(lines))
	}
	if len(lines[0]) > MaxContentBytes/2 {
		t.Fatalf("这一行不该把整份超限正文写进去，长度实得 %d", len(lines[0]))
	}
	// 摘要仍然有效：同样这份超限正文再读一次必须判重
	second, err := store.Append(dir, observedInput(big))
	if err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	if second.Appended {
		t.Fatalf("同一超限正文重复读不得再写一条")
	}
}

func TestAppendRejectsLyingInput(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()

	badKind := observedInput("a: 1")
	badKind.Kind = "draft"
	if _, err := store.Append(dir, badKind); err == nil {
		t.Fatalf("未知类型必须拒绝：编辑态草稿绝不能进历史（R5）")
	}

	noConnection := observedInput("a: 1")
	noConnection.ConnectionID = "  "
	if _, err := store.Append(dir, noConnection); err == nil {
		t.Fatalf("缺连接归属的记录无法查询，必须拒绝")
	}

	noDataID := observedInput("a: 1")
	noDataID.DataID = ""
	if _, err := store.Append(dir, noDataID); err == nil {
		t.Fatalf("缺 dataId 的记录无法归属，必须拒绝")
	}

	writeNoPlan := observedInput("a: 1")
	writeNoPlan.Kind = KindConfirmedWrite
	if _, err := store.Append(dir, writeNoPlan); err == nil {
		t.Fatalf("写入确认记录缺 planId 就断回链，必须拒绝")
	}

	if got := len(readLines(t, dir)); got != 0 {
		t.Fatalf("被拒绝的输入不得留下任何痕迹，实得 %d 行", got)
	}
}

func TestConfirmedWriteRecordCarriesPlanID(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	in := observedInput("server.port=9090\n")
	in.Kind = KindConfirmedWrite
	in.PlanID = "plan_abc_123"
	res, err := store.Append(dir, in)
	if err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	if res.Record.PlanID != "plan_abc_123" {
		t.Fatalf("planId 要能回链操作历史，实得 %q", res.Record.PlanID)
	}
	if res.Record.Kind != KindConfirmedWrite {
		t.Fatalf("类型没落盘，实得 %q", res.Record.Kind)
	}
}

func TestReadReturnsNewestFirstAndScopesByKey(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	for _, content := range []string{"v1\n", "v2\n", "v3\n"} {
		if _, err := store.Append(dir, observedInput(content)); err != nil {
			t.Fatalf("追加 %q 失败: %v", content, err)
		}
	}
	other := observedInput("gateway: on\n")
	other.ConnectionID = "conn-b"
	other.DataID = "svc.yml"
	if _, err := store.Append(dir, other); err != nil {
		t.Fatalf("追加失败: %v", err)
	}

	all := store.Read(dir, 0)
	if len(all) != 4 {
		t.Fatalf("全站应读到 4 条，实得 %d", len(all))
	}
	if all[0].Content != "gateway: on\n" {
		t.Fatalf("Read 必须最新在前，第一条实得 %q", all[0].Content)
	}
	if got := store.Read(dir, 2); len(got) != 2 {
		t.Fatalf("limit 必须生效，实得 %d", len(got))
	}

	keyed := store.ReadKey(dir, "conn-a", "public", "DEFAULT_GROUP", "app.yml", 0)
	if len(keyed) != 3 {
		t.Fatalf("按键取应当 3 条，实得 %d", len(keyed))
	}
	if keyed[0].Content != "v3\n" || keyed[2].Content != "v1\n" {
		t.Fatalf("按键取必须最新在前，实得 %q / %q", keyed[0].Content, keyed[2].Content)
	}
	for _, rec := range keyed {
		if rec.ConnectionID != "conn-a" || rec.DataID != "app.yml" {
			t.Fatalf("按键过滤漏了边界，混进 %s/%s", rec.ConnectionID, rec.DataID)
		}
	}
}

func TestStoreSurvivesRestartAndDataRootSwitch(t *testing.T) {
	dirA := t.TempDir()
	dirB := t.TempDir()
	store := NewStore()
	if _, err := store.Append(dirA, observedInput("a: 1\n")); err != nil {
		t.Fatalf("追加失败: %v", err)
	}

	// 换根（用户在设置页切目录）后不得拿旧根的索引判重，否则新根永远记不上第一版
	res, err := store.Append(dirB, observedInput("a: 1\n"))
	if err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	if !res.Appended {
		t.Fatalf("换了数据根必须重新建索引，不能被上一个根的 lastHash 骗过去")
	}

	// 进程重启 = 索引全丢，判据以文件为准：同一版仍须判重，不能重复堆积
	restarted := NewStore()
	dup, err := restarted.Append(dirB, observedInput("a: 1\n"))
	if err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	if dup.Appended {
		t.Fatalf("重启后同一版不得重复追加")
	}
	// 尾条是 a:1，写 v2 必须被记上
	if _, err := restarted.Append(dirB, observedInput("a: 2\n")); err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	if got := len(restarted.ReadKey(dirB, "conn-a", "public", "DEFAULT_GROUP", "app.yml", 0)); got != 2 {
		t.Fatalf("重启后应当看到 2 版，实得 %d", got)
	}
}

func TestPruneKeepsEarliestAnchorAndLatestN(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	const total = 12
	for i := 0; i < total; i++ {
		in := observedInput("v\n")
		in.Content = string(rune('a'+i)) + "\n"
		if _, err := store.Append(dir, in); err != nil {
			t.Fatalf("追加第 %d 条失败: %v", i, err)
		}
	}
	removed, err := store.Prune(dir, 5)
	if err != nil {
		t.Fatalf("裁剪失败: %v", err)
	}
	if removed != total-6 {
		t.Fatalf("保留最早锚点 + 最近 5 版应当删 %d 条，实得 %d", total-6, removed)
	}
	records := store.ReadKey(dir, "conn-a", "public", "DEFAULT_GROUP", "app.yml", 0)
	if len(records) != 6 {
		t.Fatalf("裁剪后应当剩 6 版，实得 %d", len(records))
	}
	// 文件里顺序仍等于写入顺序（时间序），锚点在最早那一侧
	if !strings.HasPrefix(records[5].Content, "a\n") {
		t.Fatalf("最早一版必须留作锚点，最老的一条实得 %q", records[5].Content)
	}
	if !strings.HasPrefix(records[0].Content, string(rune('a'+total-1))) {
		t.Fatalf("最新一版不得被删，最新的一条实得 %q", records[0].Content)
	}

	// 裁剪重写了文件，索引必须跟着重建：同一版再读进来仍须判重
	latest := observedInput(records[0].Content)
	res, err := store.Append(dir, latest)
	if err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	if res.Appended {
		t.Fatalf("裁剪后不得把刚写进去的版本当成新版重复追加")
	}

	// 临时文件必须收干净：崩在 rename 之前也不能留垃圾在数据目录里
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("读目录失败: %v", err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp-") {
			t.Fatalf("裁剪留下临时文件 %q", e.Name())
		}
	}
}

func TestAppendAutoPrunesWithoutLosingTheLatest(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	// 越过两倍配额，触发内联裁剪
	for i := 0; i < DefaultKeepPerKey*2+1; i++ {
		in := observedInput("x\n")
		in.Content = strings.Repeat("x", i%7+1) + string(rune('a'+i%26)) + "\n"
		if _, err := store.Append(dir, in); err != nil {
			t.Fatalf("追加第 %d 条失败: %v", i, err)
		}
	}
	records := store.ReadKey(dir, "conn-a", "public", "DEFAULT_GROUP", "app.yml", 0)
	if len(records) == 0 {
		t.Fatalf("内联裁剪不能把历史裁空")
	}
	if len(records) > DefaultKeepPerKey+1 {
		t.Fatalf("内联裁剪必须把条数压回配额内（+1 锚点），实得 %d", len(records))
	}
}

func TestClearIsIdempotentAndReopensForAppend(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	if _, err := store.Append(dir, observedInput("a: 1\n")); err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	if err := store.Clear(dir); err != nil {
		t.Fatalf("清除失败: %v", err)
	}
	if got := len(store.Read(dir, 0)); got != 0 {
		t.Fatalf("清除后不该再读到东西，实得 %d", got)
	}
	if err := store.Clear(dir); err != nil {
		t.Fatalf("清除必须幂等: %v", err)
	}
	res, err := store.Append(dir, observedInput("a: 1\n"))
	if err != nil {
		t.Fatalf("清除后追加失败: %v", err)
	}
	if !res.Appended {
		t.Fatalf("清除等于历史归零，同一版也该能重新记")
	}
	// 与审计同口径：截断不删除，路径与权限保持不变
	info, err := os.Stat(filepath.Join(dir, TrailFileName))
	if err != nil {
		t.Fatalf("文件应仍存在（截断而非删除）: %v", err)
	}
	if info.Mode().Perm() != 0o644 {
		t.Fatalf("权限应为 0644，实得 %v", info.Mode().Perm())
	}
}

func TestClearOnMissingDirIsNoop(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	if err := store.Clear(dir); err != nil {
		t.Fatalf("还没有历史时清除不该报错: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, TrailFileName)); !os.IsNotExist(err) {
		t.Fatalf("清除动作不得凭空造出一个空文件来")
	}
}

func TestBadLinesAreSkippedNotFatal(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	if _, err := store.Append(dir, observedInput("a: 1\n")); err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	good := readLines(t, dir)[0]
	raw := strings.Join([]string{
		"{ not json",
		`{"schema":1,"kind":"observed"}`, // 缺归属键：查不到也判不了重，当坏行处理
		"",
		good,
		"tail garbage",
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(dir, TrailFileName), []byte(raw), 0o644); err != nil {
		t.Fatalf("播种失败: %v", err)
	}

	records := store.Read(dir, 0)
	if len(records) != 1 {
		t.Fatalf("坏行必须跳过而不是把整份历史读没了，实得 %d", len(records))
	}
	restarted := NewStore()
	res, err := restarted.Append(dir, observedInput("a: 2\n"))
	if err != nil {
		t.Fatalf("带坏行的历史仍要能继续追加: %v", err)
	}
	if !res.Appended {
		t.Fatalf("新正文必须写进去")
	}
}

func TestFactsReportsRealVolume(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	fresh := store.GetFacts(dir)
	if fresh.Exists {
		t.Fatalf("还没写过不该谎报存在")
	}
	if fresh.Path != filepath.Join(dir, TrailFileName) {
		t.Fatalf("路径要如实给出，实得 %q", fresh.Path)
	}
	if fresh.KeepPerKey != DefaultKeepPerKey {
		t.Fatalf("保留策略要如实给出，实得 %d", fresh.KeepPerKey)
	}

	for _, dataID := range []string{"a.yml", "b.yml"} {
		in := observedInput("k: v\n")
		in.DataID = dataID
		if _, err := store.Append(dir, in); err != nil {
			t.Fatalf("追加失败: %v", err)
		}
	}
	facts := store.GetFacts(dir)
	if !facts.Exists || facts.Records != 2 || facts.Keys != 2 {
		t.Fatalf("体量事实要说实话，实得 %+v", facts)
	}
	if facts.SizeBytes <= 0 {
		t.Fatalf("字节数要如实，实得 %d", facts.SizeBytes)
	}
}

func TestRecordsNeverCarryCredentials(t *testing.T) {
	dir := t.TempDir()
	store := NewStore()
	// 正文里带密码是常态（配置本来就有），但记录不得自己长出任何凭据字段
	res, err := store.Append(dir, observedInput("password: hunter2\n"))
	if err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	line, err := json.Marshal(res.Record)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	lower := strings.ToLower(string(line))
	for _, banned := range []string{"accesstoken", "access_key", "secretkey", "password\":", "token\":"} {
		if strings.Contains(lower, banned) {
			t.Fatalf("记录自己长出了凭据字段 %q（凭据只许待在 securestore）", banned)
		}
	}
	// 字段集合必须等于设计里那份扁平清单：多一个字段就是有人在偷偷塞东西
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(line, &decoded); err != nil {
		t.Fatalf("反序列化失败: %v", err)
	}
	want := []string{
		"schema", "ts", "kind", "connectionId", "connectionName", "provider",
		"namespace", "group", "dataId", "hash", "serverMd5", "bytes", "format",
		"content", "contentOmittedReason", "planId", "appVersion",
	}
	if len(decoded) != len(want) {
		t.Fatalf("字段数量漂移，实得 %d 期望 %d（keys=%v）", len(decoded), len(want), decoded)
	}
	for _, key := range want {
		if _, ok := decoded[key]; !ok {
			t.Fatalf("缺少约定字段 %q", key)
		}
	}
}
