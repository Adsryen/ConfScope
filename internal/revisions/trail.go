// Package revisions 提供本机配置版本历史（config-revisions.jsonl）持久化。
//
// 为什么要有它（.trellis/tasks/10-21-r57-local-revision-history/design.md）：
// 版本历史原先只有 Nacos/MSE 服务端接口能给，Apollo / Consul / 本地快照用户看不到任何一版。
// 本程序不依赖中间件与云产品，自己记住「每个配置被我看到过的那几版」。
//
// 设计原则（对齐 .trellis/spec/backend/logging-guidelines.md 与 internal/audit）：
//   - JSONL 只追加，不改历史；坏行跳过不致命
//   - 文件放在 <数据根>/app-data/config-revisions.jsonl，随换根迁移一起走
//   - 绝不记录凭据；正文按单条上限钳制，超限只留摘要与字节数并如实标注
//   - 去重键是本地规范化摘要（服务端 md5 在 Apollo/Consul/本地根本不存在，不能当键）
//   - 状态（每键最后摘要与条数）挂在 Store 实例上，不做包级可变全局（backend 规约硬性禁止）
package revisions

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// TrailFileName 是本机版本历史在数据根 app-data 下的文件名。
	TrailFileName = "config-revisions.jsonl"
	// Schema 是当前记录结构版本。
	Schema = 1

	// KindObserved：本机首次读到这一版正文。时间是「首见」，不是配置中心的发布时间。
	KindObserved = "observed"
	// KindConfirmedWrite：本程序写入且写后回读确认。时间是可信的写入完成时刻。
	KindConfirmedWrite = "confirmed-write"

	// DefaultKeepPerKey 是每个配置键默认保留的最近版本数（最早那一版额外留作锚点）。
	DefaultKeepPerKey = 50
	// MaxContentBytes 是单条记录缓存正文的上限，超限只记摘要与大小。
	MaxContentBytes = 512 * 1024
	// ContentOmittedTooLarge 是正文被钳制后的如实标注（界面据此说明「这一版正文过大未缓存」）。
	ContentOmittedTooLarge = "too-large"

	// ReasonDuplicate 表示同一键的同一摘要已经记过，本次没写盘。
	ReasonDuplicate = "duplicate"
	// ReasonPromoted 表示同一版的「首见」被就地升级成「本程序写入」：
	// 正文一个字节没变（摘要相同），变的是这一版的来历，因此不新起一条版本。
	ReasonPromoted = "promoted"

	keySeparator = "\x00"
)

// Record 是一条版本记录，字段全部扁平（同审计口径，避免嵌套类型膨胀）。
type Record struct {
	Schema         int    `json:"schema"`
	TS             string `json:"ts"`
	Kind           string `json:"kind"`
	ConnectionID   string `json:"connectionId"`
	ConnectionName string `json:"connectionName"`
	Provider       string `json:"provider"`
	Namespace      string `json:"namespace"`
	Group          string `json:"group"`
	DataID         string `json:"dataId"`
	Hash           string `json:"hash"`
	ServerMD5      string `json:"serverMd5"`
	Bytes          int    `json:"bytes"`
	Format         string `json:"format"`
	Content        string `json:"content"`
	ContentOmitted string `json:"contentOmittedReason"`
	// FirstSeenTS 只在 observed 被升级为 confirmed-write 时出现：正文是同一版，
	// 首见时刻必须留着，否则界面只能拿到写入时间，「本机何时第一次看到」这条事实没了。
	FirstSeenTS string `json:"firstSeenTs"`
	PlanID      string `json:"planId"`
	AppVersion  string `json:"appVersion"`
}

// Input 是前端提交的一条观测/写入事实。摘要、大小、超限裁剪、时间戳一律由本包决定，
// 前端只负责说实话：它给什么正文，就按什么正文算指纹。
type Input struct {
	Kind           string `json:"kind"`
	ConnectionID   string `json:"connectionId"`
	ConnectionName string `json:"connectionName"`
	Provider       string `json:"provider"`
	Namespace      string `json:"namespace"`
	Group          string `json:"group"`
	DataID         string `json:"dataId"`
	Content        string `json:"content"`
	Format         string `json:"format"`
	ServerMD5      string `json:"serverMd5"`
	PlanID         string `json:"planId"`
	AppVersion     string `json:"appVersion"`
}

// AppendResult 告诉调用方这一条到底写没写盘，以及写进去的那条长什么样。
type AppendResult struct {
	Appended bool   `json:"appended"`
	Reason   string `json:"reason"`
	Record   Record `json:"record"`
}

// Facts 是这份日志的体量事实，供设置页如实展示。
type Facts struct {
	Path       string `json:"path"`
	Exists     bool   `json:"exists"`
	Records    int    `json:"records"`
	SizeBytes  int64  `json:"sizeBytes"`
	Keys       int    `json:"keys"`
	KeepPerKey int    `json:"keepPerKey"`
}

// NormalizeContent 是摘要前的规范化口径：只统一换行（CRLF/CR → LF）。
//
// 故意不做别的事（不缩进、不排序 key、不裁空白）：配置正文里一个空行、一行缩进都可能是内容本身，
// 「看起来一样的两版」在这个工具里必须判为不同；反过来同一版在 Windows/Linux 读回来只差换行符，
// 那才是真该判为相同的。与轮55「比较用字符串精确比较」同口径。
func NormalizeContent(content string) string {
	if !strings.ContainsAny(content, "\r") {
		return content
	}
	return strings.ReplaceAll(strings.ReplaceAll(content, "\r\n", "\n"), "\r", "\n")
}

// HashContent 算本地摘要，带算法前缀，将来换算法时老记录仍可自证。
func HashContent(content string) string {
	sum := sha256.Sum256([]byte(NormalizeContent(content)))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// KeyOf 是去重与保留策略的分组键：连接 + 命名空间 + 分组 + dataId。
func KeyOf(connectionID, namespace, group, dataID string) string {
	return strings.Join([]string{connectionID, namespace, group, dataID}, keySeparator)
}

// Key 返回这条记录自己的分组键。
func (r Record) Key() string {
	return KeyOf(r.ConnectionID, r.Namespace, r.Group, r.DataID)
}

// promoteOutcome 是「这一版能否把来历就地升级成 confirmed-write」的四种结局。
//
// 拆成四态而不是 bool：判重跳过与升级失败是两回事——前者这一版已经在历史里，
// 后者说明内存记忆和文件对不上，必须回落到「按新的一版落盘」，否则会静默丢掉一次写入确认。
type promoteOutcome int

const (
	// promoteDone：已把这一版的 observed 就地升级为 confirmed-write。
	promoteDone promoteOutcome = iota
	// promoteAlreadyConfirmed：这一版本来就挂着写入确认，判重即可。
	promoteAlreadyConfirmed
	// promoteIndexIsStale：文件里本键最新一版是别的内容，加速器（内存 lastHash）过期。
	promoteIndexIsStale
	// promoteNoTrailForThisKey：文件里已经找不到这个键（被外部清空或裁剪掉）。
	promoteNoTrailForThisKey
)

// Store 是版本日志的读写入口，内存索引（每键最后摘要 + 条数）只是加速器。
//
// 判据仍以文件为准：进程重启后索引丢了，最坏结果是多记一条重复，绝不会漏一版。
// 数据根可能被用户在设置页换掉，所以每次调用都按传入 dataDir 校正，不一致就重建索引。
type Store struct {
	mu       sync.Mutex
	dir      string
	lastHash map[string]string
	counts   map[string]int
	loaded   bool
}

// NewStore 创建一份带内存索引的存储句柄。
func NewStore() *Store {
	return &Store{lastHash: map[string]string{}, counts: map[string]int{}}
}

func trailPath(dataDir string) string {
	return filepath.Join(dataDir, TrailFileName)
}

// Append 追加一条记录；同一键的同一摘要已记过则跳过（幂等，批量刷新不放大写入）。
func (s *Store) Append(dataDir string, in Input) (AppendResult, error) {
	if dataDir == "" {
		return AppendResult{}, fmt.Errorf("版本历史数据目录不可用")
	}
	record, err := buildRecord(in)
	if err != nil {
		return AppendResult{}, err
	}
	key := record.Key()

	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLocked(dataDir)
	if s.lastHash[key] == record.Hash && record.Kind == KindObserved {
		return AppendResult{Appended: false, Reason: ReasonDuplicate, Record: record}, nil
	}
	if s.lastHash[key] == record.Hash {
		// 摘要与上一版相同，但这一条是「本程序写的」：先试着把来历升级，而不是当重复丢掉。
		outcome, err := s.promoteLocked(dataDir, key, record)
		if err != nil {
			return AppendResult{Record: record}, err
		}
		switch outcome {
		case promoteDone:
			return AppendResult{Appended: false, Reason: ReasonPromoted, Record: record}, nil
		case promoteAlreadyConfirmed:
			// 这一版已经挂着写入确认与 planId：重复执行同一份内容不再改写来历，也不新起一版。
			return AppendResult{Appended: false, Reason: ReasonDuplicate, Record: record}, nil
		default:
			// 文件与本进程的记忆对不上（另一个实例写过这份日志，或日志被外部动过）：
			// 判据回到文件，本次按新的一版落盘，并把索引按文件重建。
			// 绝不允许回头改更老那一行——那会把时间序和「有人在别处改回上一版」这条事实抹掉。
			// 判据回到文件。读不出来就当本键没有历史（宁可多落一条新版，也绝不回头改更老那一行）：
			// 这里若因读失败而不写，confirmed-write 那条最可靠的事实会永久丢掉。
			trail, _ := readRecords(dataDir)
			s.reindexLocked(dataDir, trail)
		}
	}
	if err := appendLine(dataDir, record); err != nil {
		return AppendResult{}, err
	}
	s.lastHash[key] = record.Hash
	s.counts[key]++
	// 攒够两倍配额再重写文件：每条都 prune 会把「追加不怕并发」的优点换成整文件反复重写。
	if s.counts[key] > DefaultKeepPerKey*2 {
		if _, err := s.pruneLocked(dataDir, DefaultKeepPerKey); err != nil {
			// 裁剪失败不影响这一条已经写进历史的事实，错误只回传给调用方记录。
			return AppendResult{Appended: true, Record: record}, fmt.Errorf("写入成功但裁剪失败: %w", err)
		}
	}
	return AppendResult{Appended: true, Record: record}, nil
}

// Read 返回最近 limit 条（跨键混排，倒序 = 最新的在前；limit<=0 时取全部上限 5000 条）。
func (s *Store) Read(dataDir string, limit int) ([]Record, error) {
	records, err := readRecords(dataDir)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 5000
	}
	if len(records) > limit {
		records = records[len(records)-limit:]
	}
	return reverseRecords(records), nil
}

// ReadKey 返回某个配置键的版本历史，最新的在前。
func (s *Store) ReadKey(dataDir, connectionID, namespace, group, dataID string, limit int) ([]Record, error) {
	records, err := readRecords(dataDir)
	if err != nil {
		return nil, err
	}
	key := KeyOf(connectionID, namespace, group, dataID)
	var out []Record
	for _, rec := range records {
		if rec.Key() == key {
			out = append(out, rec)
		}
	}
	if limit > 0 && len(out) > limit {
		out = out[len(out)-limit:]
	}
	return reverseRecords(out), nil
}

// Prune 按保留策略重写文件，返回删掉的条数。
func (s *Store) Prune(dataDir string, keepPerKey int) (int, error) {
	if dataDir == "" {
		return 0, fmt.Errorf("版本历史数据目录不可用")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pruneLocked(dataDir, keepPerKey)
}

// Clear 清空这份日志（truncate 为 0 字节，与审计同口径：保路径与权限不变，不存在时幂等成功）。
//
// 只由设置页「清除本机版本历史」调用——它是用户数据，不属于开发者「清理缓存」。
func (s *Store) Clear(dataDir string) error {
	if dataDir == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	path := trailPath(dataDir)
	if _, err := os.Stat(path); os.IsNotExist(err) {
		s.resetLocked(dataDir)
		return nil
	}
	if err := os.Truncate(path, 0); err != nil {
		return fmt.Errorf("清空本机版本历史失败: %w", err)
	}
	s.resetLocked(dataDir)
	return nil
}

// GetFacts 汇总这份日志的体量，供设置页如实说明。
func (s *Store) GetFacts(dataDir string) Facts {
	path := trailPath(dataDir)
	facts := Facts{Path: path, KeepPerKey: DefaultKeepPerKey}
	if dataDir == "" {
		return facts
	}
	info, err := os.Stat(path)
	if err != nil {
		return facts
	}
	facts.Exists = true
	facts.SizeBytes = info.Size()
	keys := map[string]bool{}
	records, err := readRecords(dataDir)
	if err == nil {
		for _, rec := range records {
			facts.Records++
			keys[rec.Key()] = true
		}
	}
	// 读不出来时 Records/Keys 保持 0，而 SizeBytes 仍按 stat 说实话：
	// 「文件有 20 KB 却一条都没记」这个自相矛盾就是提示，比整块面板凭空消失好。
	facts.Keys = len(keys)
	return facts
}

// promoteLocked 把该键最后一条「同摘要的 observed」就地改成本条 confirmed-write 记录。
//
// 为什么必须允许动这一行：执行器写后回读走的是全站唯一读取出口，那一版会先以 observed
// 落进历史；随后 recordConfirmedWrite 拿到同一摘要若只判重跳过，「这一版是本程序写的、
// 对应哪个计划」这条最可靠的事实就永久丢了。正文没变（摘要一致），改的是来历与时间戳，
// 不是伪造新版本；反过来 observed 永远不得覆盖 confirmed-write（降级会把 planId 回链弄丢）。
func (s *Store) promoteLocked(dataDir string, key string, record Record) (promoteOutcome, error) {
	records, err := readRecords(dataDir)
	if err != nil {
		// 读不出可信结果 ⇒ 不去改写任何一行，按「本键找不到落点」处理，交给调用方落一条新版。
		return promoteNoTrailForThisKey, nil
	}
	target := -1
	for i := len(records) - 1; i >= 0; i-- {
		if records[i].Key() != key {
			continue
		}
		if records[i].Hash != record.Hash {
			// 文件里本键最新一版与摘要不符：加速器过期了，按新版落盘。
			return promoteIndexIsStale, nil
		}
		if records[i].Kind == KindConfirmedWrite {
			// 这一版已经挂着写入确认与 planId，重复执行同一份内容不再动它。
			return promoteAlreadyConfirmed, nil
		}
		target = i
		break
	}
	if target < 0 {
		return promoteNoTrailForThisKey, nil
	}
	// 保留这一版第一次被看到的时刻（R6 说实话）：kind 变了，首见时间不该被写入时间盖掉。
	record.FirstSeenTS = records[target].TS
	records[target] = record
	if err := writeRecords(dataDir, records); err != nil {
		return promoteDone, err
	}
	s.reindexLocked(dataDir, records)
	return promoteDone, nil
}

// pruneLocked 必须在持有 s.mu 时调用。
func (s *Store) pruneLocked(dataDir string, keepPerKey int) (int, error) {
	if keepPerKey <= 0 {
		keepPerKey = DefaultKeepPerKey
	}
	records, err := readRecords(dataDir)
	if err != nil {
		// 压缩要重写整份文件：读不出可信结果时绝不能「按空文件重写」，那等于删光历史。
		return 0, err
	}
	if len(records) == 0 {
		s.resetLocked(dataDir)
		return 0, nil
	}
	// 每个键：最早一版留作锚点，其余只留最近 keepPerKey 条；顺序按写入先后（=时间序）。
	seen := map[string]int{}
	total := map[string]int{}
	for _, rec := range records {
		total[rec.Key()]++
	}
	keep := make([]bool, len(records))
	for i, rec := range records {
		key := rec.Key()
		seen[key]++
		isEarliest := seen[key] == 1
		fromEnd := total[key] - seen[key] + 1
		keep[i] = isEarliest || fromEnd <= keepPerKey
	}
	var kept []Record
	removed := 0
	for i, rec := range records {
		if keep[i] {
			kept = append(kept, rec)
		} else {
			removed++
		}
	}
	if removed == 0 {
		s.reindexLocked(dataDir, kept)
		return 0, nil
	}
	if err := writeRecords(dataDir, kept); err != nil {
		return 0, err
	}
	s.reindexLocked(dataDir, kept)
	return removed, nil
}

// ensureLocked 按当前数据根校内存索引；目录换了（用户换根）或索引还没建时从文件重建。
func (s *Store) ensureLocked(dataDir string) {
	if s.loaded && s.dir == dataDir {
		return
	}
	s.resetLocked(dataDir)
	// 只取每键最后摘要与条数：不缓存正文，避免这份日志把内存也吃掉一半。
	if f := openTrail(dataDir); f != nil {
		defer f.Close()
		scan := bufio.NewScanner(f)
		for scan.Buffer(make([]byte, 64*1024), 16*1024*1024); scan.Scan(); {
			rec, ok := parseLine(scan.Text())
			if !ok {
				continue
			}
			key := rec.Key()
			s.lastHash[key] = rec.Hash
			s.counts[key]++
		}
	}
	s.loaded = true
}

func (s *Store) resetLocked(dataDir string) {
	s.dir = dataDir
	s.lastHash = map[string]string{}
	s.counts = map[string]int{}
}

func (s *Store) reindexLocked(dataDir string, records []Record) {
	s.resetLocked(dataDir)
	for _, rec := range records {
		key := rec.Key()
		s.lastHash[key] = rec.Hash
		s.counts[key]++
	}
	s.loaded = true
}

// buildRecord 校验并组装记录：摘要、大小、超限裁剪、时间戳都在这里定，前端无权伪造。
func buildRecord(in Input) (Record, error) {
	kind := strings.TrimSpace(in.Kind)
	if kind != KindObserved && kind != KindConfirmedWrite {
		return Record{}, fmt.Errorf("未知的版本记录类型: %q", in.Kind)
	}
	connectionID := strings.TrimSpace(in.ConnectionID)
	dataID := strings.TrimSpace(in.DataID)
	if connectionID == "" || dataID == "" {
		return Record{}, fmt.Errorf("版本记录缺少连接或 dataId，无法归属")
	}
	if kind == KindConfirmedWrite && strings.TrimSpace(in.PlanID) == "" {
		return Record{}, fmt.Errorf("写入确认记录缺少 planId，无法回链操作历史与备份快照")
	}
	normalized := NormalizeContent(in.Content)
	record := Record{
		Schema:         Schema,
		TS:             time.Now().UTC().Format(time.RFC3339Nano),
		Kind:           kind,
		ConnectionID:   connectionID,
		ConnectionName: strings.TrimSpace(in.ConnectionName),
		Provider:       strings.TrimSpace(in.Provider),
		Namespace:      in.Namespace,
		Group:          in.Group,
		DataID:         dataID,
		Hash:           HashContent(in.Content),
		ServerMD5:      strings.TrimSpace(in.ServerMD5),
		Bytes:          len(normalized),
		Format:         strings.TrimSpace(in.Format),
		PlanID:         strings.TrimSpace(in.PlanID),
		AppVersion:     strings.TrimSpace(in.AppVersion),
	}
	// 超限只存摘要：显示半截正文比不显示更坏（用户会以为那一版就是半截）。
	if len(normalized) > MaxContentBytes {
		record.ContentOmitted = ContentOmittedTooLarge
	} else {
		record.Content = normalized
	}
	return record, nil
}

func parseLine(line string) (Record, bool) {
	line = strings.TrimSpace(line)
	if line == "" {
		return Record{}, false
	}
	var rec Record
	if err := json.Unmarshal([]byte(line), &rec); err != nil {
		return Record{}, false
	}
	if rec.Hash == "" || rec.ConnectionID == "" || rec.DataID == "" {
		return Record{}, false
	}
	return rec, true
}

/*
 * readRecords 把「没有历史」与「历史读不出来」分成两种结果说（轮67 R57-WP15）。
 *
 * 之前这两件事共用一个 nil：文件不存在、目录解析不出来、文件打不开、扫描中断，全都回
 * 空切片。界面拿到的就是「本机还没记过这一版」——一句假话，而用户恰恰在这种时候最需要
 * 知道真相（日志读不出来 ≠ 我的版本丢了）。现在只有 os.ErrNotExist 算「真的没记过」，
 * 其余一律带错误回来，让绑定层把失败如实抛给前端。
 *
 * 单行 JSON 解析失败仍按行跳过（与 internal/audit 同口径）：一条坏行不该让整屏历史黑掉，
 * 追加式日志的容错优先级高于「一行都不许少」。
 */
func readRecords(dataDir string) ([]Record, error) {
	if dataDir == "" {
		return nil, fmt.Errorf("版本历史数据目录不可用")
	}
	f, err := os.Open(trailPath(dataDir))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("打开版本历史失败: %w", err)
	}
	defer f.Close()
	var out []Record
	scan := bufio.NewScanner(f)
	for scan.Buffer(make([]byte, 64*1024), 16*1024*1024); scan.Scan(); {
		if rec, ok := parseLine(scan.Text()); ok {
			out = append(out, rec)
		}
	}
	if err := scan.Err(); err != nil {
		// 扫到一半断掉（超长行、IO 错误）：已经读到的那些条数不可信，宁可整体报失败。
		return nil, fmt.Errorf("读取版本历史中断: %w", err)
	}
	return out, nil
}

/*
 * openTrail 只负责「能不能打开」，不解释内容：ensureLocked 重建加速器时逐行自己扫，
 * 读失败与否对它无所谓——索引丢了最坏是多记一条重复。
 * 需要把「读不出来」如实上报的调用方请用 readRecords。
 */
func openTrail(dataDir string) *os.File {
	if dataDir == "" {
		return nil
	}
	f, err := os.Open(trailPath(dataDir))
	if err != nil {
		return nil
	}
	return f
}

func appendLine(dataDir string, rec Record) error {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return fmt.Errorf("创建版本历史目录失败: %w", err)
	}
	line, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("序列化版本记录失败: %w", err)
	}
	// 二次校验：JSONL 一行必须只有一个 JSON 值，且不能带裸换行。
	var probe json.RawMessage
	if err := json.Unmarshal(line, &probe); err != nil {
		return fmt.Errorf("版本记录不是合法 JSON: %w", err)
	}
	if strings.ContainsRune(string(line), '\n') {
		return fmt.Errorf("版本记录含裸换行，拒绝写入")
	}
	f, err := os.OpenFile(trailPath(dataDir), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("打开版本历史文件失败: %w", err)
	}
	defer f.Close()
	writer := bufio.NewWriter(f)
	if _, err := writer.WriteString(string(line) + "\n"); err != nil {
		return fmt.Errorf("追加版本记录失败: %w", err)
	}
	if err := writer.Flush(); err != nil {
		return fmt.Errorf("刷新版本记录失败: %w", err)
	}
	return f.Sync()
}

// writeRecords 用临时文件 + rename 原子替换，避免裁剪中途断电把历史写成半截。
func writeRecords(dataDir string, records []Record) error {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return fmt.Errorf("创建版本历史目录失败: %w", err)
	}
	tmp, err := os.CreateTemp(dataDir, TrailFileName+".tmp-*")
	if err != nil {
		return fmt.Errorf("创建临时文件失败: %w", err)
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()
	writer := bufio.NewWriter(tmp)
	for _, rec := range records {
		line, err := json.Marshal(rec)
		if err != nil {
			return fmt.Errorf("序列化版本记录失败: %w", err)
		}
		if _, err := writer.WriteString(string(line) + "\n"); err != nil {
			return fmt.Errorf("写临时版本历史失败: %w", err)
		}
	}
	if err := writer.Flush(); err != nil {
		return fmt.Errorf("刷新临时版本历史失败: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("同步临时版本历史失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("关闭临时版本历史失败: %w", err)
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return fmt.Errorf("设置版本历史文件权限失败: %w", err)
	}
	if err := os.Rename(tmpName, trailPath(dataDir)); err != nil {
		return fmt.Errorf("替换版本历史文件失败: %w", err)
	}
	return nil
}

func reverseRecords(records []Record) []Record {
	out := make([]Record, 0, len(records))
	for i := len(records) - 1; i >= 0; i-- {
		out = append(out, records[i])
	}
	return out
}
