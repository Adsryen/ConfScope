package revisions

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// 本文件管「用户想留多少版、哪一版不许丢」。
//
// 为什么这两件事必须落在磁盘上（.trellis/tasks/10-27-r99-revision-quota-and-pin/design.md §1）：
// 记版发生在前端水合之前与之中。若配额来自内存里的界面设置，进程刚起来那一段取到的是默认值，
// 拿**小**了的配额会在裁剪时永久删掉用户想留的历史，而且事后没有任何一处能解释「我的第 3 版为什么没了」。
// 反过来把它塞进主数据文档也不行：那份文件由前端 debounce 推送，Go 侧要读它就得等前端先写下来。
//
// 文件位置 <数据根>/app-data/config-revisions-policy.json 与版本日志同目录，
// 换数据根时按整目录递归搬运（internal/app 的迁移判据），这份策略因此自动随迁，不需要另立清单。

const (
	// PolicyFileName 是保留策略在数据根 app-data 下的文件名。
	PolicyFileName = "config-revisions-policy.json"
	// PolicySchema 是当前策略文件结构版本。
	PolicySchema = 1

	// MinKeepPerKey 是每键保留数的合法下界。
	// 下界不是摆设：留 1 版等于没有历史，「回滚到上一版」会经常找不到落点。
	MinKeepPerKey = 10
	// MaxKeepPerKey 是上界（正文单条另有 MaxContentBytes 钳制，这里只数条数）。
	MaxKeepPerKey = 1000
)

// 生效配额的来源档。界面据此说实话，不把「回落默认」念成「你设的值生效了」。
const (
	// KeepSourcePolicy：磁盘策略文件里的合法值。
	KeepSourcePolicy = "policy"
	// KeepSourceMissing：还没写过策略文件，用的是构建默认值。
	KeepSourceMissing = "default-missing"
	// KeepSourceUnreadable：文件读不出来或形状不对，回落默认值（不猜用户想要多少）。
	KeepSourceUnreadable = "default-unreadable"
	// KeepSourceOutOfRange：文件里的值越界，钳回默认值。
	KeepSourceOutOfRange = "default-out-of-range"
)

// PinnedRef 是一条钉住：配置键四元组 + 正文摘要。
//
// 为什么身份不是时间戳：observed 那一行会被就地升级成 confirmed-write（promoteLocked 换掉整行含 ts），
// 钉 ts 的钉会在升级那一刻静默失效。正文没变（摘要一致）才是「同一版」，钉 hash 才钉得住。
type PinnedRef struct {
	ConnectionID string `json:"connectionId"`
	Namespace    string `json:"namespace"`
	Group        string `json:"group"`
	DataID       string `json:"dataId"`
	Hash         string `json:"hash"`
}

// Key 返回这条钉住归属的配置键。
func (p PinnedRef) Key() string {
	return KeyOf(p.ConnectionID, p.Namespace, p.Group, p.DataID)
}

// Policy 是这份版本日志的数据策略。
type Policy struct {
	Schema     int         `json:"schema"`
	KeepPerKey int         `json:"keepPerKey"`
	Pinned     []PinnedRef `json:"pinned"`
}

// keepResolution 说明「这次生效的是多少、为什么是这个数」。
type keepResolution struct {
	KeepPerKey int
	Source     string
}

// PolicyView 是绑定层给界面的完整策略视图：生效值、合法区间、钉住清单都在这儿，
// 前端因此不需要自己抄一份区间或默认值（第二个判据源就是第二条 bug 线）。
type PolicyView struct {
	Path              string      `json:"path"`
	KeepPerKey        int         `json:"keepPerKey"`
	KeepSource        string      `json:"keepSource"`
	MinKeepPerKey     int         `json:"minKeepPerKey"`
	MaxKeepPerKey     int         `json:"maxKeepPerKey"`
	DefaultKeepPerKey int         `json:"defaultKeepPerKey"`
	Pinned            []PinnedRef `json:"pinned"`
	PinnedCount       int         `json:"pinnedCount"`
	UnpinnedOverQuota int         `json:"unpinnedOverQuota"`
}

// PinResult 是一次钉住/取消钉住的真实结局。
//
// Hits 是该键下正文摘要相同的行数：钉不住（Hits=0 且 Pinned=false）不是错误，
// 必须让界面能把「本机已经没有这一版正文可钉」这句话原样说出来。
type PinResult struct {
	Pinned      bool `json:"pinned"`
	Hits        int  `json:"hits"`
	PinnedCount int  `json:"pinnedCount"`
}

func policyPath(dataDir string) string {
	return filepath.Join(dataDir, PolicyFileName)
}

// clampKeepPerKey 是全包唯一的配额钳制点：与 MinKeepPerKey/MaxKeepPerKey 的比较只许出现在这里。
// 由守卫 tests/ux/revisionRetentionPolicyStaysSingleSource.test.ts 钉住——
// 「要改得改两处」在这个仓库里的代价就是界面说合法而落盘又钳了一道，或者反过来。
func clampKeepPerKey(raw int) (int, bool) {
	if raw < MinKeepPerKey || raw > MaxKeepPerKey {
		return DefaultKeepPerKey, false
	}
	return raw, true
}

// pinID 是钉住集合的成员标识：内部键 + 正文摘要。
func pinID(key string, hash string) string {
	return key + keySeparator + hash
}

// normalizePinned 丢掉缺字段的钉住并去重：钉住的行本来就要求 hash 与归属齐全才能命中，
// 留着半截条目只会让文件里出现永远钉不住东西的标记，还让人以为钉上了。
func normalizePinned(in []PinnedRef) []PinnedRef {
	out := make([]PinnedRef, 0, len(in))
	seen := map[string]bool{}
	for _, ref := range in {
		conn := strings.TrimSpace(ref.ConnectionID)
		dataID := strings.TrimSpace(ref.DataID)
		hash := strings.TrimSpace(ref.Hash)
		if conn == "" || dataID == "" || hash == "" {
			continue
		}
		id := pinID(KeyOf(conn, ref.Namespace, ref.Group, dataID), hash)
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, PinnedRef{
			ConnectionID: conn,
			Namespace:    ref.Namespace,
			Group:        ref.Group,
			DataID:       dataID,
			Hash:         hash,
		})
	}
	return out
}

// pinnedSet 把钉住清单摊成判据用的集合（含该键下所有同 hash 的行）。
func (p Policy) pinnedSet() map[string]bool {
	out := make(map[string]bool, len(p.Pinned))
	for _, ref := range p.Pinned {
		out[pinID(ref.Key(), ref.Hash)] = true
	}
	return out
}

// loadPolicy 读磁盘策略；「没有策略文件」「读不出来」「值越界」三种回落都带来源档回来。
//
// 读失败绝不报错给调用方：读不出策略时按默认值继续记版是正确的（宁可少删，也绝不因为
// 策略文件坏了就拒绝记这一版）。真正的判据仍然是「不裁剪就不删」——回落默认值只会让
// 配额偏保守，不会因为解析失败就变成「全删」或「一条不删」的另一种极端。
func loadPolicy(dataDir string) (Policy, keepResolution) {
	fallback := Policy{Schema: PolicySchema, KeepPerKey: DefaultKeepPerKey, Pinned: []PinnedRef{}}
	if dataDir == "" {
		return fallback, keepResolution{KeepPerKey: DefaultKeepPerKey, Source: KeepSourceUnreadable}
	}
	raw, err := os.ReadFile(policyPath(dataDir))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fallback, keepResolution{KeepPerKey: DefaultKeepPerKey, Source: KeepSourceMissing}
		}
		return fallback, keepResolution{KeepPerKey: DefaultKeepPerKey, Source: KeepSourceUnreadable}
	}
	var stored Policy
	if err := json.Unmarshal(raw, &stored); err != nil {
		return fallback, keepResolution{KeepPerKey: DefaultKeepPerKey, Source: KeepSourceUnreadable}
	}
	keep, ok := clampKeepPerKey(stored.KeepPerKey)
	source := KeepSourcePolicy
	if !ok {
		source = KeepSourceOutOfRange
	}
	return Policy{
		Schema:     PolicySchema,
		KeepPerKey: keep,
		Pinned:     normalizePinned(stored.Pinned),
	}, keepResolution{KeepPerKey: keep, Source: source}
}

// writePolicy 用临时文件 + rename 原子替换，与 writeRecords 同一口径：
// 策略文件半截等于配额读不出来，那种时候宁可保持老的一份完整文件。
func writePolicy(dataDir string, policy Policy) error {
	if dataDir == "" {
		return fmt.Errorf("版本历史数据目录不可用")
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return fmt.Errorf("创建版本策略目录失败: %w", err)
	}
	if policy.Schema == 0 {
		policy.Schema = PolicySchema
	}
	policy.Pinned = normalizePinned(policy.Pinned)
	payload, err := json.Marshal(policy)
	if err != nil {
		return fmt.Errorf("序列化版本保留策略失败: %w", err)
	}
	tmp, err := os.CreateTemp(dataDir, PolicyFileName+".tmp-*")
	if err != nil {
		return fmt.Errorf("创建版本策略临时文件失败: %w", err)
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()
	if _, err := tmp.Write(append(payload, '\n')); err != nil {
		return fmt.Errorf("写版本保留策略失败: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("同步版本保留策略失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("关闭版本保留策略临时文件失败: %w", err)
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return fmt.Errorf("设置版本保留策略权限失败: %w", err)
	}
	if err := os.Rename(tmpName, policyPath(dataDir)); err != nil {
		return fmt.Errorf("替换版本保留策略文件失败: %w", err)
	}
	return nil
}

// policyView 把磁盘策略摊成界面要的形状（含合法区间，前端不必自己抄常量）。
func policyView(dataDir string, policy Policy, res keepResolution) PolicyView {
	view := PolicyView{
		Path:              policyPath(dataDir),
		KeepPerKey:        res.KeepPerKey,
		KeepSource:        res.Source,
		MinKeepPerKey:     MinKeepPerKey,
		MaxKeepPerKey:     MaxKeepPerKey,
		DefaultKeepPerKey: DefaultKeepPerKey,
		Pinned:            policy.Pinned,
		PinnedCount:       len(policy.Pinned),
	}
	if view.Pinned == nil {
		view.Pinned = []PinnedRef{}
	}
	return view
}

// Policy 返回当前生效的保留策略（含钉住清单）。
func (s *Store) Policy(dataDir string) PolicyView {
	if dataDir == "" {
		return PolicyView{Pinned: []PinnedRef{}, DefaultKeepPerKey: DefaultKeepPerKey, MinKeepPerKey: MinKeepPerKey, MaxKeepPerKey: MaxKeepPerKey}
	}
	policy, res := loadPolicy(dataDir)
	view := policyView(dataDir, policy, res)
	// 「超出新上限的未钉住条数」要按文件说实话，否则设置页只能念「已保存」而没人知道
	// 磁盘上还压着 N 版随时会被下一次追加裁掉。读不出来时保持 0，由体量事实那条路报错。
	records, err := readRecords(dataDir)
	if err == nil {
		view.UnpinnedOverQuota = countUnpinnedOverQuota(records, policy.KeepPerKey, policy.pinnedSet())
	}
	return view
}

// SetPolicyKeepPerKey 保存新的每键保留数：越界一律先过唯一钳制点，返回的是**实际生效值**。
//
// 存盘不顺手删任何东西： lowering 配额只改变下一次裁剪的落点，删除动作由用户按下
// 「按新上限清理」或下一次自动裁剪完成。误删用户的历史不该是一个输入框的副作用。
func (s *Store) SetPolicyKeepPerKey(dataDir string, raw int) (PolicyView, error) {
	if dataDir == "" {
		return PolicyView{}, fmt.Errorf("版本历史数据目录不可用")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	policy, _ := loadPolicy(dataDir)
	keep, inRange := clampKeepPerKey(raw)
	policy.KeepPerKey = keep
	if err := writePolicy(dataDir, policy); err != nil {
		return PolicyView{}, err
	}
	// 落盘后按文件回读一次：界面拿到的必须是磁盘上的事实，不是刚才那个入参。
	stored, storedRes := loadPolicy(dataDir)
	view := policyView(dataDir, stored, storedRes)
	if !inRange {
		// 钳过就得说钳过：磁盘上的值本身合法，但「你要 1001、实际存了 50」这件事
		// 只有这一处知道，藏起来设置页就会念成「已按你设的值保存」。
		view.KeepSource = KeepSourceOutOfRange
	}
	records, err := readRecords(dataDir)
	if err == nil {
		view.UnpinnedOverQuota = countUnpinnedOverQuota(records, stored.KeepPerKey, stored.pinnedSet())
	}
	return view, nil
}

// SetPinned 钉住或取消钉住「某个键的某一版正文」。
//
// 幂等：重复钉同一版不再重写文件（否则 mtime 会被念成「刚刚动过」），重复取消也不报错。
// 钉不住（该键下已经没有这个摘要的行）不写悬空标记也不报错——
// 留着它只会让界面亮着一个永远命不中任何行的钉，比说清楚「这一版本机已经不在了」更坏。
func (s *Store) SetPinned(dataDir string, ref PinnedRef, pinned bool) (PinResult, error) {
	if dataDir == "" {
		return PinResult{}, fmt.Errorf("版本历史数据目录不可用")
	}
	conn := strings.TrimSpace(ref.ConnectionID)
	dataID := strings.TrimSpace(ref.DataID)
	hash := strings.TrimSpace(ref.Hash)
	if conn == "" || dataID == "" || hash == "" {
		return PinResult{}, fmt.Errorf("钉住记录缺少连接、dataId 或正文摘要，无法定位版本")
	}
	ref = PinnedRef{ConnectionID: conn, Namespace: ref.Namespace, Group: ref.Group, DataID: dataID, Hash: hash}

	s.mu.Lock()
	defer s.mu.Unlock()

	policy, _ := loadPolicy(dataDir)
	key := ref.Key()
	id := pinID(key, hash)
	records, err := readRecords(dataDir)
	if err != nil {
		return PinResult{}, err
	}
	hits := 0
	for _, rec := range records {
		if rec.Key() == key && rec.Hash == hash {
			hits++
		}
	}

	next := make([]PinnedRef, 0, len(policy.Pinned)+1)
	found := false
	for _, existing := range policy.Pinned {
		if pinID(existing.Key(), existing.Hash) == id {
			found = true
			if !pinned {
				continue // 取消钉住：把这一条摘掉
			}
		}
		next = append(next, existing)
	}
	if pinned && !found && hits == 0 {
		// 本机已经没有这一版正文可钉：如实回 hits=0，界面向用户解释为什么钉不上。
		return PinResult{Pinned: false, Hits: 0, PinnedCount: len(policy.Pinned)}, nil
	}
	if found == pinned {
		// 已经是用户要的状态（钉着再钉 / 没钉再取消）：幂等返回，不落盘。
		return PinResult{Pinned: pinned, Hits: hits, PinnedCount: len(next)}, nil
	}
	if pinned {
		next = append([]PinnedRef{ref}, next...)
	}

	if err := writePolicy(dataDir, Policy{Schema: PolicySchema, KeepPerKey: policy.KeepPerKey, Pinned: next}); err != nil {
		return PinResult{}, err
	}
	// 触发量数的是未钉住条数：钉住命中几行就从加速器里减几行，取消钉住加回几行。
	// 索引还没建时不用补——下一次 ensureLocked 会按文件与当刻钉住集合整体重建。
	if s.loaded && s.dir == dataDir {
		delta := hits
		if pinned {
			delta = -hits
		}
		s.unpinned[key] += delta
		if s.unpinned[key] <= 0 {
			delete(s.unpinned, key)
		}
	}
	return PinResult{Pinned: pinned, Hits: hits, PinnedCount: len(next)}, nil
}

// clearPinsLocked 清掉钉住清单（保留配额）：正文都没了，钉着没有落点。
func clearPinsLocked(dataDir string) error {
	policy, _ := loadPolicy(dataDir)
	if len(policy.Pinned) == 0 {
		if _, err := os.Stat(policyPath(dataDir)); errors.Is(err, os.ErrNotExist) {
			return nil
		}
	}
	return writePolicy(dataDir, Policy{Schema: PolicySchema, KeepPerKey: policy.KeepPerKey, Pinned: []PinnedRef{}})
}

// countUnpinnedOverQuota 数「按这个配额已经多出来、下一次裁剪会被删掉的未钉住行数」。
func countUnpinnedOverQuota(records []Record, keepPerKey int, pinned map[string]bool) int {
	total := map[string]int{}
	for _, rec := range records {
		if pinned[pinID(rec.Key(), rec.Hash)] {
			continue
		}
		total[rec.Key()]++
	}
	over := 0
	for _, count := range total {
		if count > keepPerKey {
			over += count - keepPerKey
		}
	}
	// 最早那一版是锚点，不参与删除：多算一条会让设置页念出一个清不掉的数。
	seen := map[string]bool{}
	for _, rec := range records {
		key := rec.Key()
		if seen[key] {
			continue
		}
		seen[key] = true
		if !pinned[pinID(key, rec.Hash)] && total[key] > keepPerKey {
			over--
		}
	}
	if over < 0 {
		over = 0
	}
	return over
}
