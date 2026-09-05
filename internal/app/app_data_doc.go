package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"confscope/internal/portabledata"
	"time"
)

const (
	appDataDocDirName       = "app-data"
	appDataDocFileName      = "confscope-data.json"
	appDataDocSchemaVersion = 2
	appDataDocCorruptSuffix = ".corrupt-"
)

// AppDataDocument 是 ConfScope 本地主数据文档，持久化在 [数据根]/app-data/confscope-data.json。
// 前端以该文档为唯一数据源，WebView localStorage 仅作为热缓存与损坏回退。
type AppDataDocument struct {
	SchemaVersion int                        `json:"schemaVersion"`
	SavedAt       string                     `json:"savedAt"`
	AppVersion    string                     `json:"appVersion"`
	Data          map[string]json.RawMessage `json:"data"`
}

// AppDataDocumentStatus 描述主数据文档读取/保存结果。
// Valid=false 时前端回退 localStorage 缓存；CorruptFile 非空表示损坏文件已被隔离保留。
type AppDataDocumentStatus struct {
	Exists        bool             `json:"exists"`
	Valid         bool             `json:"valid"`
	Path          string           `json:"path"`
	SchemaVersion int              `json:"schemaVersion"`
	SavedAt       string           `json:"savedAt"`
	AppVersion    string           `json:"appVersion"`
	SizeBytes     int64            `json:"sizeBytes"`
	CorruptFile   string           `json:"corruptFile"`
	Document      *AppDataDocument `json:"document"`
	Error         string           `json:"error"`
}

func appDataDocPath(dataRoot string) string {
	return filepath.Join(dataRoot, appDataDocDirName, appDataDocFileName)
}

func (a *App) appDataRoot() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("get executable path: %w", err)
	}
	return portabledata.DataRootFor(exePath), nil
}

// GetAppDataDocument 读取并校验主数据文档。
// 文件损坏时将其隔离为 <file>.corrupt-<ts>（保留不删），返回 Valid=false 供前端回退。
func (a *App) GetAppDataDocument() AppDataDocumentStatus {
	root, err := a.appDataRoot()
	if err != nil {
		return AppDataDocumentStatus{Error: err.Error()}
	}
	return readAppDataDocument(root)
}

// SaveAppDataDocument 原子写入主数据文档：临时文件 + 读回校验（大小/哈希）+ rename。
// 写入失败时返回 Error，前端负责重试并记录审计。
func (a *App) SaveAppDataDocument(document *AppDataDocument) AppDataDocumentStatus {
	root, err := a.appDataRoot()
	if err != nil {
		return AppDataDocumentStatus{Error: err.Error()}
	}
	return saveAppDataDocument(root, document, appVersion)
}

func readAppDataDocument(dataRoot string) AppDataDocumentStatus {
	path := appDataDocPath(dataRoot)
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return AppDataDocumentStatus{Path: path}
	}
	if err != nil {
		return AppDataDocumentStatus{Path: path, Error: err.Error()}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return AppDataDocumentStatus{Path: path, Exists: true, Error: err.Error()}
	}
	doc, err := parseAppDataDocument(raw)
	if err != nil {
		return AppDataDocumentStatus{
			Exists:      true,
			Path:        path,
			CorruptFile: quarantineCorruptAppDataDocument(path),
			Error:       err.Error(),
		}
	}
	return AppDataDocumentStatus{
		Exists:        true,
		Valid:         true,
		Path:          path,
		SchemaVersion: doc.SchemaVersion,
		SavedAt:       doc.SavedAt,
		AppVersion:    doc.AppVersion,
		SizeBytes:     info.Size(),
		Document:      doc,
	}
}

func parseAppDataDocument(raw []byte) (*AppDataDocument, error) {
	var doc AppDataDocument
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("parse app data document: %w", err)
	}
	if doc.SchemaVersion != appDataDocSchemaVersion {
		return nil, fmt.Errorf("unsupported app data document schema version: %d", doc.SchemaVersion)
	}
	if len(doc.Data) == 0 {
		return nil, errors.New("app data document has no data section")
	}
	return &doc, nil
}

func quarantineCorruptAppDataDocument(path string) string {
	corruptPath := fmt.Sprintf("%s%s%d", path, appDataDocCorruptSuffix, time.Now().UnixNano())
	if err := os.Rename(path, corruptPath); err != nil {
		return ""
	}
	return corruptPath
}

func saveAppDataDocument(dataRoot string, document *AppDataDocument, fallbackVersion string) AppDataDocumentStatus {
	path := appDataDocPath(dataRoot)
	if document == nil {
		return AppDataDocumentStatus{Path: path, Error: "app data document is nil"}
	}
	if document.SchemaVersion != appDataDocSchemaVersion {
		return AppDataDocumentStatus{Path: path, Error: fmt.Sprintf("unsupported app data document schema version: %d", document.SchemaVersion)}
	}
	if len(document.Data) == 0 {
		return AppDataDocumentStatus{Path: path, Error: "app data document has no data section"}
	}
	if document.AppVersion == "" {
		document.AppVersion = fallbackVersion
	}
	document.SavedAt = time.Now().UTC().Format(time.RFC3339Nano)
	payload, err := json.Marshal(document)
	if err != nil {
		return AppDataDocumentStatus{Path: path, Error: fmt.Sprintf("encode app data document: %v", err)}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return AppDataDocumentStatus{Path: path, Error: fmt.Sprintf("create app data directory: %v", err)}
	}
	tmpPath := fmt.Sprintf("%s.tmp-%d", path, time.Now().UnixNano())
	if err := os.WriteFile(tmpPath, payload, 0o644); err != nil {
		return AppDataDocumentStatus{Path: path, Error: fmt.Sprintf("write app data document temp file: %v", err)}
	}
	if err := verifyAppDataDocumentFile(tmpPath, payload); err != nil {
		os.Remove(tmpPath)
		return AppDataDocumentStatus{Path: path, Error: fmt.Sprintf("verify app data document: %v", err)}
	}
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return AppDataDocumentStatus{Path: path, Error: fmt.Sprintf("replace app data document: %v", err)}
	}
	info, err := os.Stat(path)
	if err != nil {
		return AppDataDocumentStatus{Path: path, Error: err.Error()}
	}
	return AppDataDocumentStatus{
		Exists:        true,
		Valid:         true,
		Path:          path,
		SchemaVersion: document.SchemaVersion,
		SavedAt:       document.SavedAt,
		AppVersion:    document.AppVersion,
		SizeBytes:     info.Size(),
		Document:      document,
	}
}

// verifyAppDataDocumentFile 读回临时文件并与期望内容比较大小与 SHA-256，防止静默写坏。
func verifyAppDataDocumentFile(path string, want []byte) error {
	got, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read back app data document: %w", err)
	}
	if len(got) != len(want) {
		return errors.New("app data document read-back size mismatch")
	}
	wantSum := sha256.Sum256(want)
	gotSum := sha256.Sum256(got)
	if !bytes.Equal(wantSum[:], gotSum[:]) {
		return errors.New("app data document read-back hash mismatch")
	}
	return nil
}
