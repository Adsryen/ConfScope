// Package snapshotwebdav 封装配置中心快照 WebDAV 加密包与远端访问逻辑。
package snapshotwebdav

const (
	// PackageSchemaVersion 是配置中心快照包 envelope 的当前版本。
	PackageSchemaVersion = 1

	// PackageFormat 是配置中心快照包的独立格式标识。
	PackageFormat = "confscope.config-snapshot"

	// PackageExtension 是配置中心快照远端包扩展名。
	PackageExtension = ".cssnapshot"

	encryptionAlgorithm = "AES-256-GCM"
	kdfAlgorithm        = "argon2id"
	argonTime           = uint32(1)
	argonMemoryKiB      = uint32(64 * 1024)
	argonThreads        = uint8(4)
	packageKeyLength    = uint32(32)
	saltLength          = 16
	nonceLength         = 12
)

// PackageSummary 是远端快照包可明文展示的摘要，不包含配置正文。
type PackageSummary struct {
	Format         string `json:"format"`
	SchemaVersion  int    `json:"schemaVersion"`
	SnapshotID     string `json:"snapshotId"`
	SnapshotName   string `json:"snapshotName"`
	Provider       string `json:"provider"`
	ConnectionID   string `json:"connectionId"`
	ConnectionName string `json:"connectionName"`
	ConfigCount    int    `json:"configCount"`
	CreatedAt      string `json:"createdAt"`
	Size           int64  `json:"size"`
}

// ImportedFrom 是导入本地快照时保留的远端来源。
type ImportedFrom struct {
	RemotePath string `json:"remotePath"`
	ImportedAt string `json:"importedAt"`
}

// WebDAVTarget 是配置中心快照 WebDAV 同步目标。
type WebDAVTarget struct {
	URL      string `json:"url"`
	Username string `json:"username"`
	Password string `json:"password"`
	RootPath string `json:"rootPath"`
}

// RemoteSnapshot 是 WebDAV 远端快照包摘要。
type RemoteSnapshot struct {
	Name           string `json:"name"`
	Path           string `json:"path"`
	Size           int64  `json:"size"`
	ModifiedAt     string `json:"modifiedAt"`
	SnapshotID     string `json:"snapshotId"`
	SnapshotName   string `json:"snapshotName"`
	Provider       string `json:"provider"`
	ConnectionID   string `json:"connectionId"`
	ConnectionName string `json:"connectionName"`
	ConfigCount    int    `json:"configCount"`
	CreatedAt      string `json:"createdAt"`
}

type encryptionInfo struct {
	Algorithm string `json:"algorithm"`
	KDF       string `json:"kdf"`
	Salt      string `json:"salt"`
	Nonce     string `json:"nonce"`
	Time      uint32 `json:"time"`
	MemoryKiB uint32 `json:"memoryKiB"`
	Threads   uint8  `json:"threads"`
	KeyLength uint32 `json:"keyLength"`
}

type packageEnvelope struct {
	Format        string         `json:"format"`
	SchemaVersion int            `json:"schemaVersion"`
	Snapshot      PackageSummary `json:"snapshot"`
	Encryption    encryptionInfo `json:"encryption"`
	Ciphertext    string         `json:"ciphertext"`
}
