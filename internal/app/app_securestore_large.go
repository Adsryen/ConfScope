package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"

	"confscope/internal/securestore"
)

// 大 secret（SSH 私钥 / 密码 / passphrase）的系统凭据库绑定。
//
// 与 SmallSecret 系列并列：小凭据走 Credential Manager / Keychain /
// Secret Service 的小条目；大凭据在 Windows 上走 DPAPI 加密文件，
// macOS / Linux 复用各自的系统凭据库。主数据 JSON 里只存指针
// （LargeSecretRef + storage），值本身不落盘。

// LargeSecretRef 是前端传入的大 secret 系统凭据库引用。
type LargeSecretRef struct {
	Namespace string `json:"namespace"`
	OwnerID   string `json:"ownerId"`
	Field     string `json:"field"`
}

// LargeSecretWriteResult 是大 secret 写入的非敏感摘要。
type LargeSecretWriteResult struct {
	Ref       LargeSecretRef `json:"ref"`
	Storage   string         `json:"storage"`
	ValueSize int            `json:"valueSize"`
	Verified  bool           `json:"verified"`
}

// largeSecretDataDir 返回数据根目录（DPAPI 文件落在其下；macOS / Linux 不使用）。
func largeSecretDataDir() (string, error) {
	layout, err := currentRuntimeLayout()
	if err != nil {
		return "", err
	}
	return layout.DataRoot, nil
}

func newPlatformLargeSecretStore() (securestore.LargeStore, error) {
	dataDir, err := largeSecretDataDir()
	if err != nil {
		return nil, err
	}
	return securestore.NewLargeStore(dataDir)
}

// WriteLargeSecret 将大 secret 写入系统凭据库，并验证读回结果。
func (a *App) WriteLargeSecret(ref LargeSecretRef, value string) (LargeSecretWriteResult, error) {
	store, err := newPlatformLargeSecretStore()
	if err != nil {
		return LargeSecretWriteResult{}, err
	}
	return runWriteLargeSecret(appContext(a), store, ref, value)
}

// ReadLargeSecret 从系统凭据库读取大 secret。
func (a *App) ReadLargeSecret(ref LargeSecretRef) (string, error) {
	store, err := newPlatformLargeSecretStore()
	if err != nil {
		return "", err
	}
	return runReadLargeSecret(appContext(a), store, ref)
}

// DeleteLargeSecret 从系统凭据库删除大 secret（幂等）。
func (a *App) DeleteLargeSecret(ref LargeSecretRef) error {
	store, err := newPlatformLargeSecretStore()
	if err != nil {
		return err
	}
	return runDeleteLargeSecret(appContext(a), store, ref)
}

func runWriteLargeSecret(
	ctx context.Context,
	store securestore.LargeStore,
	ref LargeSecretRef,
	value string,
) (LargeSecretWriteResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	largeRef, err := securestore.NewLargeRef(ref.Namespace, ref.OwnerID, ref.Field)
	if err != nil {
		return LargeSecretWriteResult{}, err
	}
	secretValue := []byte(value)
	result := LargeSecretWriteResult{
		Ref:       ref,
		Storage:   store.StorageKind(),
		ValueSize: len(secretValue),
	}

	if err := store.PutLarge(ctx, largeRef, secretValue); err != nil {
		return result, enrichLargeSecretError(err, len(secretValue))
	}
	got, err := store.GetLarge(ctx, largeRef)
	if err != nil {
		_ = store.DeleteLarge(context.Background(), largeRef)
		return result, err
	}
	if !bytes.Equal(got, secretValue) {
		_ = store.DeleteLarge(context.Background(), largeRef)
		return result, fmt.Errorf("验证系统凭据读回失败: %w", securestore.ErrSecretVerifyFailed)
	}
	result.Verified = true
	return result, nil
}

func runReadLargeSecret(ctx context.Context, store securestore.LargeStore, ref LargeSecretRef) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	largeRef, err := securestore.NewLargeRef(ref.Namespace, ref.OwnerID, ref.Field)
	if err != nil {
		return "", err
	}
	value, err := store.GetLarge(ctx, largeRef)
	if err != nil {
		return "", err
	}
	return string(value), nil
}

func runDeleteLargeSecret(ctx context.Context, store securestore.LargeStore, ref LargeSecretRef) error {
	if ctx == nil {
		ctx = context.Background()
	}
	largeRef, err := securestore.NewLargeRef(ref.Namespace, ref.OwnerID, ref.Field)
	if err != nil {
		return err
	}
	return store.DeleteLarge(ctx, largeRef)
}

// enrichLargeSecretError 把超限错误折成前端可原地显示的中文口径。
func enrichLargeSecretError(err error, valueSize int) error {
	if errors.Is(err, securestore.ErrSecretTooLarge) {
		return fmt.Errorf("%w: 凭据长度 %d 字节，超过大凭据单条上限 %d 字节，未迁移，明文保留原样",
			securestore.ErrSecretTooLarge, valueSize, securestore.MaxLargeSecretSize)
	}
	return err
}
