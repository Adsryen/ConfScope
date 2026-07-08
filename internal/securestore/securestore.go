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
