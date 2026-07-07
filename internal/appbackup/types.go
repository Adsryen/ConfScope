// Package appbackup 封装 ConfScope 应用数据备份包加密、本地文件和 WebDAV 访问逻辑。
package appbackup

// PackageSchemaVersion 是应用数据备份包 envelope 的当前版本。
const PackageSchemaVersion = 1

const packageFormat = "confscope.app-data-backup"

// PackageMeta 是备份包 envelope 中可明文展示的元信息。
type PackageMeta struct {
	AppVersion     string `json:"appVersion"`
	SourcePlatform string `json:"sourcePlatform"`
	CreatedAt      string `json:"createdAt"`
}

// Summary 是加密包不解密或解密后可展示的摘要。
type Summary struct {
	Format         string `json:"format"`
	SchemaVersion  int    `json:"schemaVersion"`
	AppVersion     string `json:"appVersion"`
	SourcePlatform string `json:"sourcePlatform"`
	CreatedAt      string `json:"createdAt"`
	Size           int64  `json:"size"`
}

// DecryptedPackage 是解密后的备份包内容与摘要。
type DecryptedPackage struct {
	PlaintextJSON string  `json:"plaintextJson"`
	Summary       Summary `json:"summary"`
}

// WebDAVTarget 是单个默认 WebDAV 备份目标。
type WebDAVTarget struct {
	URL      string `json:"url"`
	Username string `json:"username"`
	Password string `json:"password"`
	RootPath string `json:"rootPath"`
}

// RemoteBackup 是 WebDAV 远端备份文件摘要。
type RemoteBackup struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Size       int64  `json:"size"`
	ModifiedAt string `json:"modifiedAt"`
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
	Format         string         `json:"format"`
	SchemaVersion  int            `json:"schemaVersion"`
	CreatedAt      string         `json:"createdAt"`
	AppVersion     string         `json:"appVersion"`
	SourcePlatform string         `json:"sourcePlatform"`
	Encryption     encryptionInfo `json:"encryption"`
	Ciphertext     string         `json:"ciphertext"`
}
