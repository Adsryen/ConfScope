package provider

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	SnapshotSchemaVersion = 1
	SnapshotLayout        = "confscope-v1"
	SnapshotToolVersion   = "confscope"
)

// ValidateLocalSnapshotDirectory 校验本地快照目录结构。
func ValidateLocalSnapshotDirectory(path string) LocalSnapshotValidation {
	result := LocalSnapshotValidation{
		Path:      strings.TrimSpace(path),
		CheckedAt: time.Now().Format(time.RFC3339),
	}
	if result.Path == "" {
		result.Code = "empty_path"
		result.Message = "本地快照目录不能为空"
		return result
	}

	info, err := os.Stat(result.Path)
	if err != nil {
		if os.IsNotExist(err) {
			result.Code = "not_found"
			result.Message = "目录不存在"
		} else {
			result.Code = "stat_error"
			result.Message = err.Error()
		}
		return result
	}
	if !info.IsDir() {
		result.Code = "not_directory"
		result.Message = "路径不是文件夹"
		return result
	}

	if strict, handled := validateStrictSnapshot(result.Path, result.CheckedAt); handled {
		return strict
	}
	return validateLegacySnapshot(result)
}

func validateStrictSnapshot(root string, checkedAt string) (LocalSnapshotValidation, bool) {
	result := LocalSnapshotValidation{
		Path:           root,
		CheckedAt:      checkedAt,
		HasManifest:    true,
		MatchedMarkers: []string{"metadata.json"},
		Layout:         SnapshotLayout,
	}
	metaPath := filepath.Join(root, "metadata.json")
	data, err := os.ReadFile(metaPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return LocalSnapshotValidation{}, false
		}
		result.Code = "read_error"
		result.Message = err.Error()
		return result, true
	}

	var probe struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		result.Code = "invalid_metadata"
		result.Message = "metadata.json 不是有效 JSON"
		return result, true
	}
	if probe.SchemaVersion == 0 {
		return LocalSnapshotValidation{}, false
	}
	result.SchemaVersion = probe.SchemaVersion
	if probe.SchemaVersion != SnapshotSchemaVersion {
		result.Code = "unsupported_schema_version"
		result.Message = "不支持的本地快照 schemaVersion"
		return result, true
	}

	var snapshot Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		result.Code = "invalid_metadata"
		result.Message = "metadata.json 不是有效快照元信息"
		return result, true
	}
	if !hasRequiredSnapshotFields(snapshot) {
		result.Code = "missing_schema_fields"
		result.Message = "metadata.json 缺少必要字段"
		return result, true
	}

	configCount := 0
	for _, cfg := range snapshot.Configs {
		namespace := cfg.Namespace
		if namespace == "" {
			namespace = snapshotNamespaceDir(snapshot.Source)
		}
		contentPath := filepath.Join(root, "configs", namespaceDirName(namespace), cfg.Group, filepath.FromSlash(cfg.DataID))
		if _, err := os.Stat(contentPath); err != nil {
			result.Code = "missing_configs"
			result.Message = "未找到可对比的配置文件"
			return result, true
		}
		configCount++
	}

	result.Valid = true
	result.Code = "valid"
	result.Message = "本地快照目录结构有效"
	result.ConfigCount = configCount
	result.MatchedMarkers = append(result.MatchedMarkers, "configs/")
	return result, true
}

func hasRequiredSnapshotFields(snapshot Snapshot) bool {
	if snapshot.SchemaVersion != SnapshotSchemaVersion || snapshot.ID == "" || snapshot.ToolVersion == "" {
		return false
	}
	if snapshot.Source.Provider == "" || snapshot.Source.ConnectionID == "" || snapshot.Source.ConnectionName == "" {
		return false
	}
	if len(snapshot.Configs) == 0 {
		return false
	}
	for _, cfg := range snapshot.Configs {
		if cfg.Group == "" || cfg.DataID == "" || cfg.ContentType == "" {
			return false
		}
	}
	return true
}

func validateLegacySnapshot(result LocalSnapshotValidation) LocalSnapshotValidation {
	entries, err := os.ReadDir(result.Path)
	if err != nil {
		result.Code = "read_error"
		result.Message = err.Error()
		return result
	}
	for _, entry := range entries {
		name := strings.ToLower(entry.Name())
		if entry.IsDir() {
			if isLocalStructureDir(name) {
				result.MatchedMarkers = append(result.MatchedMarkers, entry.Name()+"/")
			}
			continue
		}
		if isLocalManifest(name) {
			result.HasManifest = true
			result.MatchedMarkers = append(result.MatchedMarkers, entry.Name())
		}
	}

	result.ConfigCount = countLocalConfigFiles(result.Path)
	if !result.HasManifest && len(result.MatchedMarkers) == 0 {
		result.Code = "missing_structure"
		result.Message = "未找到快照清单或标准目录结构"
		return result
	}
	if result.ConfigCount == 0 {
		result.Code = "missing_configs"
		result.Message = "未找到可对比的配置文件"
		return result
	}

	result.Valid = true
	result.Code = "legacy_valid"
	result.Message = "本地快照目录使用旧结构，建议重新生成快照"
	result.Legacy = true
	return result
}

func countLocalConfigFiles(root string) int {
	configCount := 0
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := strings.ToLower(d.Name())
		if isLocalManifest(name) {
			return nil
		}
		if isLocalConfigExt(strings.ToLower(filepath.Ext(path))) {
			configCount++
		}
		return nil
	})
	return configCount
}

func namespaceDirName(namespace string) string {
	if namespace == "" {
		return "public"
	}
	return namespace
}

func isLocalStructureDir(name string) bool {
	switch strings.ToLower(name) {
	case "configs", "namespaces":
		return true
	default:
		return false
	}
}
