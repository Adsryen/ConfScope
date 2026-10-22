package portabledata

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// 数据根迁移（轮62 R-C/R-D）：切换目录是「一次带日志的复制优先迁移」，
// 任何情况下都不 move、不删源、不删旧根。用户看不到数据比目录乱更不可接受
// （2026-09-04 事故的教训，见 AGENTS.md 数据目录纪律）。

// DataRootMigrationPlan 是迁移前的预览（设置页据此让用户确认「将复制多少项」）。
type DataRootMigrationPlan struct {
	Source          string      `json:"source"`
	Target          string      `json:"target"`
	Mode            RuntimeMode `json:"mode"`
	ItemCount       int         `json:"itemCount"`
	TotalBytes      int64       `json:"totalBytes"`
	HasSourceData   bool        `json:"hasSourceData"`
	Resumable       bool        `json:"resumable"`
	ReusedItems     int         `json:"reusedItems"`
	Warnings        []string    `json:"warnings"`
	RequiresRestart bool        `json:"requiresRestart"`
	Valid           bool        `json:"valid"`
	Error           string      `json:"error"`
}

// DataRootMigrationResult 是迁移执行结果。
type DataRootMigrationResult struct {
	Source          string   `json:"source"`
	Target          string   `json:"target"`
	ItemsCopied     int      `json:"itemsCopied"`
	ItemsReused     int      `json:"itemsReused"`
	PointerPath     string   `json:"pointerPath"`
	MigratedMarker  string   `json:"migratedMarker"`
	RequiresRestart bool     `json:"requiresRestart"`
	RestartReason   string   `json:"restartReason"`
	Notes           []string `json:"notes"`
	Error           string   `json:"error"`
}

// MainDataDocSummary 是主数据文件的可比信息（回退确认时给用户看两侧新旧）。
type MainDataDocSummary struct {
	Exists    bool   `json:"exists"`
	Path      string `json:"path"`
	SavedAt   string `json:"savedAt"`
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256"`
}

// DataRootRollbackStatus 是「回退到旧位置」的入口判据与展示数据。
type DataRootRollbackStatus struct {
	Available    bool               `json:"available"`
	CurrentRoot  string             `json:"currentRoot"`
	PreviousRoot string             `json:"previousRoot"`
	CurrentDoc   MainDataDocSummary `json:"currentDoc"`
	PreviousDoc  MainDataDocSummary `json:"previousDoc"`
	Reason       string             `json:"reason"`
}

// migrationJournal 是目标根里的断点记录，用于幂等续跑。
type migrationJournal struct {
	Source    string            `json:"source"`
	Target    string            `json:"target"`
	StartedAt string            `json:"startedAt"`
	Copied    map[string]string `json:"copied"` // relPath -> sha256
}

// runtimeContext 是迁移所需的运行环境，单测注入后不会碰真实 OS 目录。
type runtimeContext struct {
	exePath       string
	lookupEnv     func(string) (string, bool)
	osDataDir     func() (string, error)
	pointerDir    func() (string, error)
	probeWritable func(string) bool
	now           func() int64
}

func realRuntime() runtimeContext {
	exePath, err := os.Executable()
	if err != nil {
		exePath = filepath.Join(".", "ConfScope")
	}
	return runtimeContext{
		exePath:       exePath,
		lookupEnv:     os.LookupEnv,
		osDataDir:     OsUserDataDir,
		pointerDir:    OsPointerDir,
		probeWritable: probeWritable,
		now:           func() int64 { return time.Now().UnixNano() },
	}
}

func (c runtimeContext) layout() (RuntimeLayout, error) {
	return resolveLayout(layoutInput{
		exePath:       c.exePath,
		lookupEnv:     c.lookupEnv,
		osDataDir:     c.osDataDir,
		pointerDir:    c.pointerDir,
		probeWritable: c.probeWritable,
	})
}

// PlanDataRootMigration 预览迁往 target 的影响；校验不过时 Valid=false + 中文原因。
func PlanDataRootMigration(target string) DataRootMigrationPlan {
	return planDataRootMigration(target, realRuntime())
}

// MigrateDataRoot 执行迁移（复制优先 + 读回校验 + 写指针 + 旧根留标记）。
func MigrateDataRoot(target string) (DataRootMigrationResult, error) {
	return migrateDataRoot(target, realRuntime())
}

// CheckDataRootRollback 判断能否回退到上一次迁移前的旧根。
func CheckDataRootRollback() DataRootRollbackStatus {
	return checkDataRootRollback(realRuntime())
}

// RollbackDataRoot 把数据根指回 previousRoot（只改指针，不搬不删任何文件）。
func RollbackDataRoot() (DataRootMigrationResult, error) {
	return rollbackDataRoot(realRuntime())
}

func planDataRootMigration(target string, ctx runtimeContext) DataRootMigrationPlan {
	layout, err := ctx.layout()
	if err != nil {
		return DataRootMigrationPlan{Target: strings.TrimSpace(target), Error: err.Error()}
	}
	plan, planErr := buildMigrationPlan(layout, target, ctx)
	if planErr != nil {
		plan.Valid = false
		plan.Error = planErr.Error()
	}
	return plan
}

func migrateDataRoot(target string, ctx runtimeContext) (DataRootMigrationResult, error) {
	layout, err := ctx.layout()
	if err != nil {
		return DataRootMigrationResult{}, err
	}
	plan, err := buildMigrationPlan(layout, target, ctx)
	if err != nil {
		return DataRootMigrationResult{}, err
	}

	if err := os.MkdirAll(plan.Target, 0o755); err != nil {
		return DataRootMigrationResult{}, fmt.Errorf("创建目标数据根失败: %w", err)
	}
	journalPath := filepath.Join(plan.Target, MigrationJournalFileName)
	journal := loadMigrationJournal(journalPath, plan.Source, plan.Target)
	// 子目录一律由复制时按需创建：提前建空目录既会在失败时留下垃圾，
	// 又会让「续跑」被同名冲突校验误判成危险操作。
	files, _, err := listMigrationItems(plan.Source)
	if err != nil {
		return DataRootMigrationResult{}, err
	}

	if journal.Copied == nil {
		journal.Copied = map[string]string{}
	}
	journal.Source = plan.Source
	journal.Target = plan.Target
	if err := saveMigrationJournal(journalPath, journal); err != nil {
		return DataRootMigrationResult{}, fmt.Errorf("写入迁移断点记录失败: %w", err)
	}

	written := make([]string, 0, len(files))
	copied := 0
	reused := 0
	notes := append([]string{}, plan.Warnings...)
	for _, rel := range files {
		sourcePath := filepath.Join(plan.Source, rel)
		digest, size, err := fileDigest(sourcePath)
		if err != nil {
			cleanupWritten(plan.Target, written)
			return DataRootMigrationResult{}, fmt.Errorf("读取源文件失败: %w", err)
		}
		// 只有「目标里已是源内容」才算复用；断点记录说拷过但内容对不上时重新拷——
		// 新根还没被程序读过（指针未切），覆盖不会丢用户改动。
		if targetDigest, _, statErr := fileDigest(filepath.Join(plan.Target, rel)); statErr == nil && targetDigest == digest {
			reused++
			continue
		}
		if err := copyVerifiedFile(sourcePath, filepath.Join(plan.Target, rel), size); err != nil {
			cleanupWritten(plan.Target, written)
			return DataRootMigrationResult{}, fmt.Errorf("复制 %s 失败: %w", rel, err)
		}
		if journal.Copied == nil {
			journal.Copied = map[string]string{}
		}
		journal.Copied[rel] = digest
		written = append(written, rel)
		copied++
		if err := saveMigrationJournal(journalPath, journal); err != nil {
			cleanupWritten(plan.Target, written)
			return DataRootMigrationResult{}, fmt.Errorf("更新迁移断点记录失败: %w", err)
		}
	}

	// 复制结果必须逐文件对得上，否则宁可不切指针。
	if err := verifyCopiedFiles(plan.Source, plan.Target, files); err != nil {
		cleanupWritten(plan.Target, written)
		return DataRootMigrationResult{}, err
	}

	pointerPath := layout.PointerPath
	if pointerPath == "" {
		cleanupWritten(plan.Target, written)
		return DataRootMigrationResult{}, errors.New("取不到指针文件路径，无法记录新数据根（请手动设置 CONFSCOPE_DATA_DIR 后重试）")
	}
	if err := SaveDataRootPointer(pointerPath, DataRootPointer{DataRoot: plan.Target, PreviousRoot: plan.Source}); err != nil {
		cleanupWritten(plan.Target, written)
		return DataRootMigrationResult{}, err
	}
	markerName := MigratedMarkerFileName(ctx.now())
	markerPath := filepath.Join(plan.Source, markerName)
	markerPayload := fmt.Sprintf("ConfScope 数据根已迁移到 %s\n时间：%s\n本目录内容未删除，可在设置页「回退到旧位置」。\n",
		plan.Target, time.Now().Format(time.RFC3339))
	if err := os.WriteFile(markerPath, []byte(markerPayload), 0o644); err != nil {
		// 标记写失败不影响迁移成功（指针已生效），只作为提示。
		notes = append(notes, fmt.Sprintf("旧根迁移标记写入失败：%v", err))
	}
	if err := os.Remove(journalPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		notes = append(notes, fmt.Sprintf("迁移断点记录清理失败：%v", err))
	}

	return DataRootMigrationResult{
		Source:          plan.Source,
		Target:          plan.Target,
		ItemsCopied:     copied,
		ItemsReused:     reused,
		PointerPath:     pointerPath,
		MigratedMarker:  markerPath,
		RequiresRestart: true,
		RestartReason:   "WebView 用户数据目录在窗口创建前就已确定，换根必须重启进程才生效",
		Notes:           notes,
	}, nil
}

func buildMigrationPlan(layout RuntimeLayout, rawTarget string, ctx runtimeContext) (DataRootMigrationPlan, error) {
	target := strings.TrimSpace(rawTarget)
	if target == "" {
		return DataRootMigrationPlan{Source: layout.DataRoot}, errors.New("请先选择目标目录")
	}
	if !filepath.IsAbs(target) {
		return DataRootMigrationPlan{Source: layout.DataRoot}, fmt.Errorf("目标必须是绝对路径：%s", target)
	}
	target = filepath.Clean(target)
	source := layout.DataRoot
	plan := DataRootMigrationPlan{Source: source, Target: target, Mode: layout.Mode, RequiresRestart: true}

	if pathsEqual(source, target) {
		return plan, fmt.Errorf("目标目录与当前数据根相同：%s", target)
	}
	if isAncestorDir(source, target) {
		return plan, fmt.Errorf("目标不能在当前数据根内部，否则会把目录拷进自己的子目录：%s", target)
	}
	if isAncestorDir(target, source) {
		return plan, fmt.Errorf("当前数据根在目标目录内部，换根后路径会自我包含：%s", target)
	}
	homeDir, _ := os.UserHomeDir()
	if homeDir != "" && pathsEqual(target, homeDir) {
		return plan, errors.New("目标不能直接是用户主目录，请选一个专属子目录")
	}
	if filepath.Dir(target) == target {
		return plan, errors.New("目标不能是磁盘根目录，请选一个专属子目录")
	}
	// 安装态下禁止把数据放进安装目录：卸载程序会连数据一起删（见 installer 任务 R1）。
	if layout.Mode == RuntimeModeInstalled && isAncestorDir(layout.ExeDir, target) {
		return plan, errors.New("安装形态下不能把数据放在程序目录内，卸载会连数据一起删掉")
	}

	// 断点记录：上次未完成迁移留下的，用来把「续跑」和「目标里真有另一份数据」区分开。
	journal := loadMigrationJournal(filepath.Join(target, MigrationJournalFileName), source, target)
	resumeNames := copiedTopLevelNames(journal)

	info, statErr := os.Stat(target)
	switch {
	case statErr == nil && !info.IsDir():
		return plan, fmt.Errorf("目标已存在同名文件，不是目录：%s", target)
	case statErr == nil:
		if hasMainDataFile(target) && !journalCoversRel(journal, mainDataDocRel()) {
			return plan, fmt.Errorf("目标目录里已有另一份 ConfScope 数据：%s，请先手动合并或换目录", target)
		}
		if !ctx.probeWritable(target) {
			return plan, fmt.Errorf("目标目录不可写：%s", target)
		}
		conflicts, err := collectNameConflicts(source, target)
		if err != nil {
			return plan, err
		}
		if unexplained := filterUncoveredConflicts(conflicts, resumeNames); len(unexplained) > 0 {
			return plan, fmt.Errorf("目标目录已有同名条目，无法安全合并：%s", strings.Join(unexplained, "、"))
		}
		if len(resumeNames) > 0 {
			plan.Resumable = true
			plan.ReusedItems = len(journal.Copied)
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("检测到上次未完成的迁移记录，本次会跳过 %d 个已复制的文件", len(journal.Copied)))
		}
	case errors.Is(statErr, os.ErrNotExist):
		parent := filepath.Dir(target)
		if !ctx.probeWritable(parent) {
			return plan, fmt.Errorf("目标目录不存在且其上级不可写：%s", parent)
		}
	default:
		return plan, fmt.Errorf("检查目标目录失败：%w", statErr)
	}

	sourceFiles, _, err := listMigrationItems(source)
	if err != nil {
		return plan, err
	}
	plan.ItemCount = len(sourceFiles)
	for _, rel := range sourceFiles {
		if info, statErr := os.Stat(filepath.Join(source, rel)); statErr == nil {
			plan.TotalBytes += info.Size()
		}
	}
	plan.HasSourceData = plan.ItemCount > 0 || hasMainDataFile(source)
	if !plan.HasSourceData {
		plan.Warnings = append(plan.Warnings, "当前数据根没有主数据文件，迁移后新根同样从空开始（不会丢历史）")
	}
	if layout.Source == RootSourceEnv {
		plan.Warnings = append(plan.Warnings, "当前数据根来自环境变量 CONFSCOPE_DATA_DIR，它的优先级高于本选择，换根后请同步去掉该环境变量")
	}
	plan.Valid = true
	return plan, nil
}

// isRuntimeNoise 是数据根里不属于用户数据的运行时产物。
func isRuntimeNoise(name string) bool {
	switch name {
	case PointerFileName, InstallMarkerFileName, MigrationJournalFileName:
		return true
	}
	return strings.HasPrefix(name, MigratedMarkerPrefix) || strings.HasPrefix(name, ".confscope-writable-probe")
}

// copiedTopLevelNames 从断点记录推出「目标里哪些条目是本次迁移自己拷的」。
func mainDataDocRel() string {
	return filepath.Join(AppDataDirName, AppDataDocFileName)
}

// journalCoversRel 判目标里的这条相对路径是不是「本次迁移的上半场自己拷的」。
func journalCoversRel(journal *migrationJournal, rel string) bool {
	if journal == nil || journal.Copied == nil {
		return false
	}
	return journal.Copied[rel] != "" || journal.Copied[filepath.ToSlash(rel)] != ""
}

func copiedTopLevelNames(journal *migrationJournal) map[string]bool {
	names := map[string]bool{}
	if journal == nil {
		return names
	}
	for rel := range journal.Copied {
		head := strings.SplitN(filepath.ToSlash(rel), "/", 2)[0]
		if head != "" && head != "." {
			names[head] = true
		}
	}
	return names
}

func filterUncoveredConflicts(conflicts []string, covered map[string]bool) []string {
	unexplained := make([]string, 0, len(conflicts))
	for _, name := range conflicts {
		if !covered[name] {
			unexplained = append(unexplained, name)
		}
	}
	return unexplained
}

func collectNameConflicts(source string, target string) ([]string, error) {
	entries, err := os.ReadDir(target)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("读取目标目录失败：%w", err)
	}
	targetNames := map[string]bool{}
	for _, entry := range entries {
		if entry.Name() == MigrationJournalFileName {
			continue
		}
		targetNames[entry.Name()] = true
	}
	sourceEntries, err := os.ReadDir(source)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("读取当前数据根失败：%w", err)
	}
	conflicts := make([]string, 0, 4)
	for _, entry := range sourceEntries {
		if isRuntimeNoise(entry.Name()) {
			continue
		}
		if targetNames[entry.Name()] {
			conflicts = append(conflicts, entry.Name())
		}
	}
	sort.Strings(conflicts)
	return conflicts, nil
}

// listMigrationItems 摊平源根下的目录与文件（相对路径，确定性排序）。
func listMigrationItems(source string) ([]string, []string, error) {
	if _, err := os.Stat(source); errors.Is(err, os.ErrNotExist) {
		return nil, nil, nil
	} else if err != nil {
		return nil, nil, fmt.Errorf("读取当前数据根失败: %w", err)
	}
	var files []string
	var dirs []string
	err := filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		if isRuntimeNoise(filepath.Base(rel)) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			dirs = append(dirs, rel)
			return nil
		}
		files = append(files, rel)
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	sort.Strings(files)
	sort.Strings(dirs)
	return files, dirs, nil
}

func fileDigest(path string) (string, int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", 0, err
	}
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(hash.Sum(nil)), info.Size(), nil
}

// copyVerifiedFile 先写临时文件再读回校验最后 rename，绝不留半成品。
func copyVerifiedFile(sourcePath string, targetPath string, wantSize int64) error {
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return err
	}
	info, err := os.Stat(sourcePath)
	if err != nil {
		return err
	}
	tmpPath := fmt.Sprintf("%s.confscope-tmp-%d", targetPath, time.Now().UnixNano())
	in, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	sourceDigest, _, err := fileDigest(sourcePath)
	if err != nil {
		os.Remove(tmpPath)
		return err
	}
	targetDigest, targetSize, err := fileDigest(tmpPath)
	if err != nil {
		os.Remove(tmpPath)
		return err
	}
	if targetDigest != sourceDigest || targetSize != wantSize {
		os.Remove(tmpPath)
		return fmt.Errorf("读回校验不一致：%s", targetPath)
	}
	if err := os.Rename(tmpPath, targetPath); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return nil
}

func verifyCopiedFiles(source string, target string, files []string) error {
	for _, rel := range files {
		sourceDigest, _, err := fileDigest(filepath.Join(source, rel))
		if err != nil {
			return fmt.Errorf("校验源文件失败: %w", err)
		}
		targetDigest, _, err := fileDigest(filepath.Join(target, rel))
		if err != nil {
			return fmt.Errorf("目标缺少 %s: %w", rel, err)
		}
		if sourceDigest != targetDigest {
			return fmt.Errorf("目标文件内容与源不一致: %s", rel)
		}
	}
	return nil
}

// cleanupWritten 只删本次自己刚拷出去的文件：绝不 RemoveAll 目标目录
// （那里可能本来就有用户的别的东西），更绝不碰源目录。
func cleanupWritten(target string, written []string) {
	for _, rel := range written {
		_ = os.Remove(filepath.Join(target, rel))
	}
}

func loadMigrationJournal(path string, source string, target string) *migrationJournal {
	raw, err := os.ReadFile(path)
	if err != nil {
		return &migrationJournal{Source: source, Target: target}
	}
	var journal migrationJournal
	if err := json.Unmarshal(raw, &journal); err != nil || journal.Source != source || journal.Target != target {
		return &migrationJournal{Source: source, Target: target}
	}
	return &journal
}

func saveMigrationJournal(path string, journal *migrationJournal) error {
	journal.StartedAt = time.Now().UTC().Format(time.RFC3339Nano)
	payload, err := json.MarshalIndent(journal, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, payload, 0o600)
}

func summariseMainDataDoc(dataRoot string) MainDataDocSummary {
	path := MainDataDocPath(dataRoot)
	info, err := os.Stat(path)
	if err != nil {
		return MainDataDocSummary{Path: path}
	}
	digest, size, err := fileDigest(path)
	if err != nil {
		return MainDataDocSummary{Exists: true, Path: path, SizeBytes: size}
	}
	return MainDataDocSummary{Exists: true, Path: path, SavedAt: readMainDataDocSavedAt(path), SizeBytes: info.Size(), SHA256: digest}
}

func readMainDataDocSavedAt(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var probe struct {
		SavedAt string `json:"savedAt"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return ""
	}
	return probe.SavedAt
}

func checkDataRootRollback(ctx runtimeContext) DataRootRollbackStatus {
	layout, err := ctx.layout()
	if err != nil {
		return DataRootRollbackStatus{Reason: err.Error()}
	}
	status := DataRootRollbackStatus{CurrentRoot: layout.DataRoot, PreviousRoot: layout.PreviousRoot}
	if layout.PreviousRoot == "" {
		status.Reason = "没有可回退的旧位置（本程序没做过换根迁移）"
		return status
	}
	status.CurrentDoc = summariseMainDataDoc(layout.DataRoot)
	status.PreviousDoc = summariseMainDataDoc(layout.PreviousRoot)
	if !status.PreviousDoc.Exists {
		status.Reason = fmt.Sprintf("旧位置没有主数据文件：%s", layout.PreviousRoot)
		return status
	}
	status.Available = true
	return status
}

func rollbackDataRoot(ctx runtimeContext) (DataRootMigrationResult, error) {
	status := checkDataRootRollback(ctx)
	if !status.Available {
		return DataRootMigrationResult{}, errors.New(status.Reason)
	}
	layout, err := ctx.layout()
	if err != nil {
		return DataRootMigrationResult{}, err
	}
	if layout.PointerPath == "" {
		return DataRootMigrationResult{}, errors.New("取不到指针文件路径，无法回退")
	}
	if err := SaveDataRootPointer(layout.PointerPath, DataRootPointer{DataRoot: status.PreviousRoot, PreviousRoot: status.CurrentRoot}); err != nil {
		return DataRootMigrationResult{}, err
	}
	return DataRootMigrationResult{
		Source:          status.CurrentRoot,
		Target:          status.PreviousRoot,
		PointerPath:     layout.PointerPath,
		RequiresRestart: true,
		RestartReason:   "换根只在进程启动时生效",
		Notes: []string{
			fmt.Sprintf("当前位置保留了 %d 个数据文件，回退后不再被读取（未删除）", status.CurrentDoc.SizeBytes),
		},
	}, nil
}
