package provider

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var errLocalReadOnly = errors.New("local snapshot provider is read-only")

type LocalProvider struct{}

type localConfigFile struct {
	ref     ConfigRef
	path    string
	format  string
	content string
}

func NewLocalProvider() *LocalProvider {
	return &LocalProvider{}
}

func (p *LocalProvider) ListNamespaces(profile ConnectionProfile) ([]Namespace, error) {
	files, err := scanLocalSnapshot(profile)
	if err != nil {
		return nil, err
	}
	counts := map[string]int64{}
	for _, file := range files {
		counts[file.ref.Namespace]++
	}
	namespaces := make([]Namespace, 0, len(counts))
	for id, count := range counts {
		name := id
		if name == "" {
			name = "public"
		}
		namespaces = append(namespaces, Namespace{
			ID:          id,
			Name:        name,
			ConfigCount: count,
		})
	}
	sort.Slice(namespaces, func(i, j int) bool {
		if namespaces[i].ID == "" || namespaces[j].ID == "" {
			return namespaces[i].ID == ""
		}
		return namespaces[i].Name < namespaces[j].Name
	})
	return namespaces, nil
}

func (p *LocalProvider) ListConfigs(profile ConnectionProfile, req ListConfigsRequest) (ConfigPage, error) {
	files, err := scanLocalSnapshot(profile)
	if err != nil {
		return ConfigPage{}, err
	}
	filtered := make([]localConfigFile, 0, len(files))
	for _, file := range files {
		if req.Namespace != "" && file.ref.Namespace != req.Namespace {
			continue
		}
		if req.Group != "" && file.ref.Group != req.Group {
			continue
		}
		if req.DataID != "" && file.ref.DataID != req.DataID {
			continue
		}
		filtered = append(filtered, file)
	}
	sort.Slice(filtered, func(i, j int) bool {
		if filtered[i].ref.Namespace != filtered[j].ref.Namespace {
			return filtered[i].ref.Namespace < filtered[j].ref.Namespace
		}
		if filtered[i].ref.Group != filtered[j].ref.Group {
			return filtered[i].ref.Group < filtered[j].ref.Group
		}
		return filtered[i].ref.DataID < filtered[j].ref.DataID
	})

	pageNo := req.PageNo
	if pageNo <= 0 {
		pageNo = 1
	}
	pageSize := req.PageSize
	if pageSize <= 0 {
		pageSize = int64(len(filtered))
	}
	start := int((pageNo - 1) * pageSize)
	if start > len(filtered) {
		start = len(filtered)
	}
	end := start + int(pageSize)
	if end > len(filtered) {
		end = len(filtered)
	}

	items := make([]ConfigSummary, 0, end-start)
	for _, file := range filtered[start:end] {
		items = append(items, ConfigSummary{
			Ref:     normalizeLocalRef(profile, file.ref),
			Content: file.content,
			Format:  file.format,
		})
	}
	pages := int64(0)
	if len(filtered) > 0 && pageSize > 0 {
		pages = (int64(len(filtered)) + pageSize - 1) / pageSize
	}
	return ConfigPage{
		TotalCount:     int64(len(filtered)),
		PageNumber:     pageNo,
		PagesAvailable: pages,
		PageItems:      items,
	}, nil
}

func (p *LocalProvider) GetConfig(profile ConnectionProfile, ref ConfigRef) (ConfigDocument, error) {
	files, err := scanLocalSnapshot(profile)
	if err != nil {
		return ConfigDocument{}, err
	}
	ref = normalizeLocalRef(profile, ref)
	for _, file := range files {
		fileRef := normalizeLocalRef(profile, file.ref)
		if fileRef.Namespace == ref.Namespace && fileRef.Group == ref.Group && fileRef.DataID == ref.DataID {
			return ConfigDocument{
				Ref:     fileRef,
				Content: file.content,
				Format:  file.format,
				Source:  file.path,
			}, nil
		}
	}
	return ConfigDocument{}, fmt.Errorf("local config not found: namespace=%s group=%s dataId=%s", ref.Namespace, ref.Group, ref.DataID)
}

func (p *LocalProvider) PublishConfig(profile ConnectionProfile, req PublishConfigRequest) error {
	return errLocalReadOnly
}

func (p *LocalProvider) DeleteConfig(profile ConnectionProfile, ref ConfigRef) error {
	return errLocalReadOnly
}

func (p *LocalProvider) ListHistory(profile ConnectionProfile, ref ConfigRef, page PageRequest) (HistoryPage, error) {
	return HistoryPage{}, errLocalReadOnly
}

func (p *LocalProvider) GetHistoryDetail(profile ConnectionProfile, ref ConfigRef, id string) (HistoryDetail, error) {
	return HistoryDetail{}, errLocalReadOnly
}

func (p *LocalProvider) TestConnection(profile ConnectionProfile) error {
	_, err := scanLocalSnapshot(profile)
	return err
}

func scanLocalSnapshot(profile ConnectionProfile) ([]localConfigFile, error) {
	root := strings.TrimSpace(profile.BaseURL)
	if root == "" {
		return nil, errors.New("local snapshot directory is required")
	}
	info, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("local snapshot path is not a directory")
	}
	if !hasLocalSnapshotMarker(root) {
		return nil, errors.New("local snapshot marker not found")
	}

	files := []localConfigFile{}
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := strings.ToLower(d.Name())
		if isLocalManifest(name) || !isLocalConfigExt(filepath.Ext(name)) {
			return nil
		}
		content, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		ref, ok := inferLocalConfigRef(root, path)
		if !ok {
			return nil
		}
		files = append(files, localConfigFile{
			ref:     normalizeLocalRef(profile, ref),
			path:    path,
			format:  localFormatFromExt(filepath.Ext(path)),
			content: string(content),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, errors.New("no comparable config files found in local snapshot")
	}
	return files, nil
}

func inferLocalConfigRef(root string, path string) (ConfigRef, bool) {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return ConfigRef{}, false
	}
	parts := splitLocalPath(rel)
	if len(parts) == 0 {
		return ConfigRef{}, false
	}
	if len(parts) >= 4 && strings.EqualFold(parts[0], "configs") {
		return ConfigRef{
			Provider:  ProviderLocal,
			Namespace: normalizeLocalNamespace(parts[1]),
			Group:     parts[2],
			DataID:    strings.Join(parts[3:], "/"),
		}, true
	}
	if len(parts) >= 4 && strings.EqualFold(parts[0], "namespaces") {
		return ConfigRef{
			Provider:  ProviderLocal,
			Namespace: normalizeLocalNamespace(parts[1]),
			Group:     parts[2],
			DataID:    strings.Join(parts[3:], "/"),
		}, true
	}
	if len(parts) >= 3 {
		return ConfigRef{
			Provider:  ProviderLocal,
			Namespace: normalizeLocalNamespace(parts[0]),
			Group:     parts[1],
			DataID:    strings.Join(parts[2:], "/"),
		}, true
	}
	return ConfigRef{
		Provider:  ProviderLocal,
		Namespace: "",
		Group:     "DEFAULT_GROUP",
		DataID:    strings.Join(parts, "/"),
	}, true
}

func normalizeLocalNamespace(namespace string) string {
	if strings.EqualFold(namespace, "public") {
		return ""
	}
	return namespace
}

func hasLocalSnapshotMarker(root string) bool {
	entries, err := os.ReadDir(root)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		name := strings.ToLower(entry.Name())
		if entry.IsDir() {
			if name == "configs" || name == "namespaces" {
				return true
			}
			continue
		}
		if isLocalManifest(name) {
			return true
		}
	}
	return false
}

func splitLocalPath(path string) []string {
	raw := strings.FieldsFunc(filepath.ToSlash(path), func(r rune) bool { return r == '/' })
	parts := make([]string, 0, len(raw))
	for _, part := range raw {
		if part != "" && part != "." {
			parts = append(parts, part)
		}
	}
	return parts
}

func normalizeLocalRef(profile ConnectionProfile, ref ConfigRef) ConfigRef {
	ref.Provider = ProviderLocal
	if ref.ConnectionID == "" {
		ref.ConnectionID = profile.ID
	}
	if ref.Group == "" {
		ref.Group = "DEFAULT_GROUP"
	}
	return ref
}

func isLocalManifest(name string) bool {
	switch strings.ToLower(name) {
	case "confscope.snapshot.json", "manifest.json", "metadata.json", ".metadata.yml", ".metadata.yaml":
		return true
	default:
		return false
	}
}

func isLocalConfigExt(ext string) bool {
	switch strings.ToLower(ext) {
	case ".json", ".yaml", ".yml", ".properties", ".xml", ".toml", ".ini", ".txt":
		return true
	default:
		return false
	}
}

func localFormatFromExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".json":
		return "json"
	case ".yaml", ".yml":
		return "yaml"
	case ".properties":
		return "properties"
	case ".xml":
		return "xml"
	case ".toml":
		return "toml"
	case ".ini":
		return "ini"
	case ".txt":
		return "text"
	default:
		return "text"
	}
}
