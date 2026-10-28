// Package securestore 封装 ConfScope 后续凭据安全迁移的最小 PoC 接口。
package securestore

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

const (
	targetPrefix = "ConfScope"

	// MaxCredentialBlobSize 是 Windows CRED_MAX_CREDENTIAL_BLOB_SIZE 的大小。
	MaxCredentialBlobSize = 5 * 512

	// MaxLargeSecretSize 是大 secret（SSH 私钥等）单条的上限，
	// 远小于任何平台的系统凭据库实际容量，只防误把非凭据材料写进去。
	MaxLargeSecretSize = 1024 * 1024
)

var (
	// ErrInvalidSecretRef 表示 secret reference 无法安全映射为系统凭据目标名。
	ErrInvalidSecretRef = errors.New("invalid secret reference")
	// ErrSecretTooLarge 表示 secret 超过当前 WinCred PoC 可安全保存的大小。
	ErrSecretTooLarge = errors.New("secret too large")
	// ErrUnsupportedPlatform 表示当前平台尚未实现系统凭据库。
	ErrUnsupportedPlatform = errors.New("secure store unsupported on this platform")
	// ErrSecretNotFound 表示系统凭据库中不存在指定 secret。
	ErrSecretNotFound = errors.New("secret not found")
	// ErrSecretVerifyFailed 表示系统凭据库写入后的读回或删除校验失败。
	ErrSecretVerifyFailed = errors.New("secret verification failed")
	// ErrSecretServiceUnavailable 表示 Linux 上没有可用的 Secret Service
	// （无 D-Bus 会话总线、无密钥环守护进程、或实现不支持当前协议）。
	// 消息必须包含「不支持」，前端据此把迁移状态归为 unsupported（未迁入），
	// 而不是静默降级成明文落数据目录。
	ErrSecretServiceUnavailable = errors.New("系统凭据库（secret service）不可用，当前环境不支持")
)

// Store 是系统凭据库 PoC 的最小读写接口。
type Store interface {
	Put(ctx context.Context, ref SecretRef, value []byte) error
	Get(ctx context.Context, ref SecretRef) ([]byte, error)
	Delete(ctx context.Context, ref SecretRef) error
}

// SecretRef 是 localStorage 未来可持久化的非敏感 secret 引用。
type SecretRef struct {
	Namespace string
	OwnerID   string
	Field     string
}

// NewSecretRef 创建并校验 secret 引用。
func NewSecretRef(namespace string, ownerID string, field string) (SecretRef, error) {
	ref := SecretRef{
		Namespace: strings.TrimSpace(namespace),
		OwnerID:   strings.TrimSpace(ownerID),
		Field:     strings.TrimSpace(field),
	}
	if !validPart(ref.Namespace) {
		return SecretRef{}, fmt.Errorf("%w: namespace", ErrInvalidSecretRef)
	}
	if !validPart(ref.OwnerID) {
		return SecretRef{}, fmt.Errorf("%w: ownerID", ErrInvalidSecretRef)
	}
	if ref.Field != "" && !validPart(ref.Field) {
		return SecretRef{}, fmt.Errorf("%w: field", ErrInvalidSecretRef)
	}
	return ref, nil
}

// TargetName 返回系统凭据库中的目标名。
func (r SecretRef) TargetName() string {
	if r.Field == "" {
		return fmt.Sprintf("%s/%s/%s", targetPrefix, r.Namespace, r.OwnerID)
	}
	return fmt.Sprintf("%s/%s/%s/%s", targetPrefix, r.Namespace, r.OwnerID, r.Field)
}

// ValidateSecretValue 校验 secret 值是否能进入当前 WinCred PoC。
func ValidateSecretValue(value []byte) error {
	if len(value) > MaxCredentialBlobSize {
		return fmt.Errorf("%w: %d > %d", ErrSecretTooLarge, len(value), MaxCredentialBlobSize)
	}
	return nil
}

// NewCredentialManagerStore 创建当前平台的 Credential Manager store。
func NewCredentialManagerStore() Store {
	return newPlatformCredentialManagerStore()
}

// LargeRef 是大 secret（SSH 私钥 / 密码 / passphrase）的系统凭据库引用。
// 与 SecretRef 分开校验：namespace 与 field 只接受 SSH auth family 的精确身份，
// 不允许通配或任意字符串进入存储层。
type LargeRef struct {
	Namespace string
	OwnerID   string
	Field     string
}

// NewLargeRef 创建并校验大 secret 引用。
func NewLargeRef(namespace string, ownerID string, field string) (LargeRef, error) {
	ref := LargeRef{
		Namespace: strings.TrimSpace(namespace),
		OwnerID:   strings.TrimSpace(ownerID),
		Field:     strings.TrimSpace(field),
	}
	switch ref.Namespace {
	case "connection-ssh", "ssh-profile":
	default:
		return LargeRef{}, fmt.Errorf("%w: namespace %q", ErrInvalidSecretRef, ref.Namespace)
	}
	if !validPart(ref.OwnerID) {
		return LargeRef{}, fmt.Errorf("%w: ownerID", ErrInvalidSecretRef)
	}
	switch ref.Field {
	case "password", "privateKey", "passphrase":
	default:
		return LargeRef{}, fmt.Errorf("%w: field %q", ErrInvalidSecretRef, ref.Field)
	}
	return ref, nil
}

// TargetName 返回系统凭据库中的目标名。
func (r LargeRef) TargetName() string {
	return fmt.Sprintf("%s/%s/%s/%s", targetPrefix, r.Namespace, r.OwnerID, r.Field)
}

// ValidateLargeSecretValue 校验大 secret 值是否在允许的上限内。
func ValidateLargeSecretValue(value []byte) error {
	if len(value) > MaxLargeSecretSize {
		return fmt.Errorf("%w: %d > %d", ErrSecretTooLarge, len(value), MaxLargeSecretSize)
	}
	return nil
}

// LargeStore 是大 secret 的平台存储接口。
// 与 Store 并列而不是复用：Windows 小凭据走 Credential Manager（2560 上限），
// 大凭据走 DPAPI 加密文件；macOS/Linux 两侧共用各自的系统凭据库。
type LargeStore interface {
	PutLarge(ctx context.Context, ref LargeRef, value []byte) error
	GetLarge(ctx context.Context, ref LargeRef) ([]byte, error)
	DeleteLarge(ctx context.Context, ref LargeRef) error
	// StorageKind 返回实现名（keychain / secret-service / dpapi-file），
	// 供前端指针记录「这份凭据当时落在哪种存储」，便于换机排查。
	StorageKind() string
}

// NewLargeStore 创建当前平台的大 secret store。
// dataDir 是数据根目录：Windows 的 DPAPI 文件落在其下；macOS/Linux 不使用。
// Linux 上构造时会探测 Secret Service，不可用则返回 ErrSecretServiceUnavailable。
func NewLargeStore(dataDir string) (LargeStore, error) {
	return newPlatformLargeStore(dataDir)
}

func validPart(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '-' || r == '_' || r == '.':
		default:
			return false
		}
	}
	return true
}
