package snapshotwebdav

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"confscope/internal/provider"
	"golang.org/x/crypto/argon2"
)

type packagePayload struct {
	Metadata provider.Snapshot `json:"metadata"`
}

// EncryptPackage 使用一次性快照包密码加密配置中心快照。
func EncryptPackage(snapshot provider.Snapshot, password string) ([]byte, PackageSummary, error) {
	if strings.TrimSpace(password) == "" {
		return nil, PackageSummary{}, fmt.Errorf("快照包密码不能为空")
	}
	if err := validateSnapshotForPackage(snapshot); err != nil {
		return nil, PackageSummary{}, err
	}
	payload, err := json.Marshal(packagePayload{Metadata: snapshot})
	if err != nil {
		return nil, PackageSummary{}, fmt.Errorf("编码快照包 payload 失败: %w", err)
	}
	salt, err := randomBytes(saltLength)
	if err != nil {
		return nil, PackageSummary{}, fmt.Errorf("生成快照包盐值失败: %w", err)
	}
	nonce, err := randomBytes(nonceLength)
	if err != nil {
		return nil, PackageSummary{}, fmt.Errorf("生成快照包 nonce 失败: %w", err)
	}
	key := deriveKey(password, salt, argonTime, argonMemoryKiB, argonThreads, packageKeyLength)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, PackageSummary{}, fmt.Errorf("创建快照包加密器失败: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, PackageSummary{}, fmt.Errorf("创建快照包 GCM 失败: %w", err)
	}
	envelope := packageEnvelope{
		Format:        PackageFormat,
		SchemaVersion: PackageSchemaVersion,
		Snapshot:      summaryFromSnapshot(snapshot, 0),
		Encryption: encryptionInfo{
			Algorithm: encryptionAlgorithm,
			KDF:       kdfAlgorithm,
			Salt:      base64.StdEncoding.EncodeToString(salt),
			Nonce:     base64.StdEncoding.EncodeToString(nonce),
			Time:      argonTime,
			MemoryKiB: argonMemoryKiB,
			Threads:   argonThreads,
			KeyLength: packageKeyLength,
		},
		Ciphertext: base64.StdEncoding.EncodeToString(gcm.Seal(nil, nonce, payload, nil)),
	}
	out, err := json.MarshalIndent(envelope, "", "  ")
	if err != nil {
		return nil, PackageSummary{}, fmt.Errorf("编码快照包失败: %w", err)
	}
	summary := envelope.Snapshot
	summary.Size = int64(len(out))
	return out, summary, nil
}

// DecryptPackage 使用一次性快照包密码解密配置中心快照包。
func DecryptPackage(packageBytes []byte, password string) (provider.Snapshot, PackageSummary, error) {
	if strings.TrimSpace(password) == "" {
		return provider.Snapshot{}, PackageSummary{}, fmt.Errorf("快照包密码不能为空")
	}
	envelope, summary, err := parseEnvelopeSummary(packageBytes)
	if err != nil {
		return provider.Snapshot{}, PackageSummary{}, err
	}
	if envelope.Encryption.Algorithm != encryptionAlgorithm || envelope.Encryption.KDF != kdfAlgorithm {
		return provider.Snapshot{}, PackageSummary{}, fmt.Errorf("不支持的快照包加密方式")
	}
	salt, err := base64.StdEncoding.DecodeString(envelope.Encryption.Salt)
	if err != nil {
		return provider.Snapshot{}, PackageSummary{}, fmt.Errorf("快照包盐值无效: %w", err)
	}
	nonce, err := base64.StdEncoding.DecodeString(envelope.Encryption.Nonce)
	if err != nil {
		return provider.Snapshot{}, PackageSummary{}, fmt.Errorf("快照包 nonce 无效: %w", err)
	}
	ciphertext, err := base64.StdEncoding.DecodeString(envelope.Ciphertext)
	if err != nil {
		return provider.Snapshot{}, PackageSummary{}, fmt.Errorf("快照包密文无效: %w", err)
	}
	keyLength := envelope.Encryption.KeyLength
	if keyLength == 0 {
		keyLength = packageKeyLength
	}
	key := deriveKey(password, salt, envelope.Encryption.Time, envelope.Encryption.MemoryKiB, envelope.Encryption.Threads, keyLength)
	block, err := aes.NewCipher(key)
	if err != nil {
		return provider.Snapshot{}, PackageSummary{}, fmt.Errorf("创建快照包解密器失败: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return provider.Snapshot{}, PackageSummary{}, fmt.Errorf("创建快照包 GCM 失败: %w", err)
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return provider.Snapshot{}, PackageSummary{}, fmt.Errorf("快照包密码错误或文件已损坏: %w", err)
	}
	var payload packagePayload
	if err := json.Unmarshal(plaintext, &payload); err != nil {
		return provider.Snapshot{}, PackageSummary{}, fmt.Errorf("解析快照包 payload 失败: %w", err)
	}
	if err := validateSnapshotForPackage(payload.Metadata); err != nil {
		return provider.Snapshot{}, PackageSummary{}, err
	}
	return payload.Metadata, summary, nil
}

// ReadPackageSummary 读取快照包明文摘要，不解密配置正文。
func ReadPackageSummary(packageBytes []byte) (PackageSummary, error) {
	_, summary, err := parseEnvelopeSummary(packageBytes)
	return summary, err
}

func parseEnvelopeSummary(packageBytes []byte) (packageEnvelope, PackageSummary, error) {
	var envelope packageEnvelope
	if err := json.Unmarshal(packageBytes, &envelope); err != nil {
		return packageEnvelope{}, PackageSummary{}, fmt.Errorf("解析快照包失败: %w", err)
	}
	if envelope.Format != PackageFormat {
		return packageEnvelope{}, PackageSummary{}, fmt.Errorf("快照包格式无效")
	}
	if envelope.SchemaVersion != PackageSchemaVersion {
		return packageEnvelope{}, PackageSummary{}, fmt.Errorf("不支持的快照包版本: %d", envelope.SchemaVersion)
	}
	summary := envelope.Snapshot
	summary.Format = envelope.Format
	summary.SchemaVersion = envelope.SchemaVersion
	summary.Size = int64(len(packageBytes))
	if summary.SnapshotID == "" {
		return packageEnvelope{}, PackageSummary{}, fmt.Errorf("快照包摘要缺少 snapshotId")
	}
	return envelope, summary, nil
}

func validateSnapshotForPackage(snapshot provider.Snapshot) error {
	if snapshot.SchemaVersion != provider.SnapshotSchemaVersion || snapshot.ID == "" || snapshot.ToolVersion == "" {
		return fmt.Errorf("快照元信息不完整")
	}
	if snapshot.Source.Provider == "" || snapshot.Source.ConnectionID == "" || snapshot.Source.ConnectionName == "" {
		return fmt.Errorf("快照元信息不完整")
	}
	if len(snapshot.Configs) == 0 {
		return fmt.Errorf("快照元信息不完整")
	}
	for _, cfg := range snapshot.Configs {
		if cfg.Group == "" || cfg.DataID == "" || cfg.ContentType == "" {
			return fmt.Errorf("快照元信息不完整")
		}
	}
	return nil
}

func summaryFromSnapshot(snapshot provider.Snapshot, size int64) PackageSummary {
	return PackageSummary{
		Format:         PackageFormat,
		SchemaVersion:  PackageSchemaVersion,
		SnapshotID:     snapshot.ID,
		SnapshotName:   snapshot.Name,
		Provider:       string(snapshot.Source.Provider),
		ConnectionID:   snapshot.Source.ConnectionID,
		ConnectionName: snapshot.Source.ConnectionName,
		ConfigCount:    len(snapshot.Configs),
		CreatedAt:      snapshot.CreatedAt,
		Size:           size,
	}
}

func randomBytes(size int) ([]byte, error) {
	out := make([]byte, size)
	if _, err := rand.Read(out); err != nil {
		return nil, err
	}
	return out, nil
}

func deriveKey(password string, salt []byte, time uint32, memoryKiB uint32, threads uint8, keyLength uint32) []byte {
	if time == 0 {
		time = argonTime
	}
	if memoryKiB == 0 {
		memoryKiB = argonMemoryKiB
	}
	if threads == 0 {
		threads = argonThreads
	}
	if keyLength == 0 {
		keyLength = packageKeyLength
	}
	return argon2.IDKey([]byte(password), salt, time, memoryKiB, threads, keyLength)
}
