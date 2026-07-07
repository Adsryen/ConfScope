package appbackup

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

const (
	encryptionAlgorithm = "AES-256-GCM"
	kdfAlgorithm        = "argon2id"
	argonTime           = uint32(1)
	argonMemoryKiB      = uint32(64 * 1024)
	argonThreads        = uint8(4)
	backupKeyLength     = uint32(32)
	saltLength          = 16
	nonceLength         = 12
)

// EncryptPackage 使用备份密码加密应用数据 payload，并返回可落盘的备份包。
func EncryptPackage(plaintext []byte, password string, meta PackageMeta) ([]byte, Summary, error) {
	if strings.TrimSpace(password) == "" {
		return nil, Summary{}, fmt.Errorf("备份密码不能为空")
	}
	salt, err := randomBytes(saltLength)
	if err != nil {
		return nil, Summary{}, fmt.Errorf("生成备份盐值失败: %w", err)
	}
	nonce, err := randomBytes(nonceLength)
	if err != nil {
		return nil, Summary{}, fmt.Errorf("生成备份 nonce 失败: %w", err)
	}
	key := deriveKey(password, salt, argonTime, argonMemoryKiB, argonThreads, backupKeyLength)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, Summary{}, fmt.Errorf("创建备份加密器失败: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, Summary{}, fmt.Errorf("创建备份 GCM 失败: %w", err)
	}
	envelope := packageEnvelope{
		Format:         packageFormat,
		SchemaVersion:  PackageSchemaVersion,
		CreatedAt:      meta.CreatedAt,
		AppVersion:     meta.AppVersion,
		SourcePlatform: meta.SourcePlatform,
		Encryption: encryptionInfo{
			Algorithm: encryptionAlgorithm,
			KDF:       kdfAlgorithm,
			Salt:      base64.StdEncoding.EncodeToString(salt),
			Nonce:     base64.StdEncoding.EncodeToString(nonce),
			Time:      argonTime,
			MemoryKiB: argonMemoryKiB,
			Threads:   argonThreads,
			KeyLength: backupKeyLength,
		},
		Ciphertext: base64.StdEncoding.EncodeToString(gcm.Seal(nil, nonce, plaintext, nil)),
	}
	out, err := json.MarshalIndent(envelope, "", "  ")
	if err != nil {
		return nil, Summary{}, fmt.Errorf("编码备份包失败: %w", err)
	}
	return out, summaryFromEnvelope(envelope, int64(len(out))), nil
}

// DecryptPackage 使用备份密码解密应用数据备份包。
func DecryptPackage(packageBytes []byte, password string) ([]byte, Summary, error) {
	if strings.TrimSpace(password) == "" {
		return nil, Summary{}, fmt.Errorf("备份密码不能为空")
	}
	var envelope packageEnvelope
	if err := json.Unmarshal(packageBytes, &envelope); err != nil {
		return nil, Summary{}, fmt.Errorf("解析备份包失败: %w", err)
	}
	if envelope.Format != packageFormat {
		return nil, Summary{}, fmt.Errorf("备份包格式无效")
	}
	if envelope.SchemaVersion != PackageSchemaVersion {
		return nil, Summary{}, fmt.Errorf("不支持的备份包版本: %d", envelope.SchemaVersion)
	}
	if envelope.Encryption.Algorithm != encryptionAlgorithm || envelope.Encryption.KDF != kdfAlgorithm {
		return nil, Summary{}, fmt.Errorf("不支持的备份包加密方式")
	}
	salt, err := base64.StdEncoding.DecodeString(envelope.Encryption.Salt)
	if err != nil {
		return nil, Summary{}, fmt.Errorf("备份包盐值无效: %w", err)
	}
	nonce, err := base64.StdEncoding.DecodeString(envelope.Encryption.Nonce)
	if err != nil {
		return nil, Summary{}, fmt.Errorf("备份包 nonce 无效: %w", err)
	}
	ciphertext, err := base64.StdEncoding.DecodeString(envelope.Ciphertext)
	if err != nil {
		return nil, Summary{}, fmt.Errorf("备份包密文无效: %w", err)
	}
	keyLength := envelope.Encryption.KeyLength
	if keyLength == 0 {
		keyLength = backupKeyLength
	}
	key := deriveKey(password, salt, envelope.Encryption.Time, envelope.Encryption.MemoryKiB, envelope.Encryption.Threads, keyLength)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, Summary{}, fmt.Errorf("创建备份解密器失败: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, Summary{}, fmt.Errorf("创建备份 GCM 失败: %w", err)
	}
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, Summary{}, fmt.Errorf("备份密码错误或文件已损坏: %w", err)
	}
	return plaintext, summaryFromEnvelope(envelope, int64(len(packageBytes))), nil
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
		keyLength = backupKeyLength
	}
	return argon2.IDKey([]byte(password), salt, time, memoryKiB, threads, keyLength)
}

func summaryFromEnvelope(envelope packageEnvelope, size int64) Summary {
	return Summary{
		Format:         envelope.Format,
		SchemaVersion:  envelope.SchemaVersion,
		AppVersion:     envelope.AppVersion,
		SourcePlatform: envelope.SourcePlatform,
		CreatedAt:      envelope.CreatedAt,
		Size:           size,
	}
}
