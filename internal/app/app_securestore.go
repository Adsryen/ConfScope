package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"

	"confscope/internal/securestore"
)

// SecureSecretRef 是前端传入的系统凭据库引用。
type SecureSecretRef struct {
	Namespace string `json:"namespace"`
	OwnerID   string `json:"ownerId"`
	Field     string `json:"field"`
}

// SecureSecretWriteResult 是真实凭据写入的非敏感摘要。
type SecureSecretWriteResult struct {
	Ref        SecureSecretRef `json:"ref"`
	TargetName string          `json:"targetName"`
	ValueSize  int             `json:"valueSize"`
	Verified   bool            `json:"verified"`
}

// CredentialStorePoCResult 是凭据库最小 PoC 的非敏感执行摘要。
type CredentialStorePoCResult struct {
	OK         bool   `json:"ok"`
	TargetName string `json:"targetName"`
	ReadBackOK bool   `json:"readBackOk"`
	Deleted    bool   `json:"deleted"`
	ValueSize  int    `json:"valueSize"`
}

// WriteSecureSecret 将真实小凭据写入系统凭据库，并验证读回结果。
func (a *App) WriteSecureSecret(ref SecureSecretRef, value string) (SecureSecretWriteResult, error) {
	return runWriteSecureSecret(appContext(a), securestore.NewCredentialManagerStore(), ref, value)
}

// ReadSecureSecret 从系统凭据库读取真实小凭据。
func (a *App) ReadSecureSecret(ref SecureSecretRef) (string, error) {
	return runReadSecureSecret(appContext(a), securestore.NewCredentialManagerStore(), ref)
}

// DeleteSecureSecret 从系统凭据库删除真实小凭据。
func (a *App) DeleteSecureSecret(ref SecureSecretRef) error {
	return runDeleteSecureSecret(appContext(a), securestore.NewCredentialManagerStore(), ref)
}

// RunCredentialStorePoC 运行 Windows Credential Manager 最小 PoC。
//
// 该绑定只写入 ConfScope/poc/<run-id> 测试凭据，成功后立即删除；它不读取、
// 迁移或修改任何真实连接、SSH、WebDAV 凭据。
func (a *App) RunCredentialStorePoC(runID string) (CredentialStorePoCResult, error) {
	return runCredentialStorePoC(appContext(a), securestore.NewCredentialManagerStore(), runID)
}

func appContext(a *App) context.Context {
	if a != nil && a.ctx != nil {
		return a.ctx
	}
	return context.Background()
}

func toSecureStoreRef(ref SecureSecretRef) (securestore.SecretRef, error) {
	return securestore.NewSecretRef(ref.Namespace, ref.OwnerID, ref.Field)
}

func runWriteSecureSecret(
	ctx context.Context,
	store securestore.Store,
	ref SecureSecretRef,
	value string,
) (SecureSecretWriteResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	secretRef, err := toSecureStoreRef(ref)
	if err != nil {
		return SecureSecretWriteResult{}, err
	}
	secretValue := []byte(value)
	result := SecureSecretWriteResult{
		Ref:        ref,
		TargetName: secretRef.TargetName(),
		ValueSize:  len(secretValue),
	}

	if err := store.Put(ctx, secretRef, secretValue); err != nil {
		return result, err
	}
	got, err := store.Get(ctx, secretRef)
	if err != nil {
		_ = store.Delete(context.Background(), secretRef)
		return result, err
	}
	if !bytes.Equal(got, secretValue) {
		_ = store.Delete(context.Background(), secretRef)
		return result, fmt.Errorf("验证系统凭据读回失败: %w", securestore.ErrSecretVerifyFailed)
	}
	result.Verified = true
	return result, nil
}

func runReadSecureSecret(ctx context.Context, store securestore.Store, ref SecureSecretRef) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	secretRef, err := toSecureStoreRef(ref)
	if err != nil {
		return "", err
	}
	value, err := store.Get(ctx, secretRef)
	if err != nil {
		return "", err
	}
	return string(value), nil
}

func runDeleteSecureSecret(ctx context.Context, store securestore.Store, ref SecureSecretRef) error {
	if ctx == nil {
		ctx = context.Background()
	}
	secretRef, err := toSecureStoreRef(ref)
	if err != nil {
		return err
	}
	return store.Delete(ctx, secretRef)
}

func runCredentialStorePoC(ctx context.Context, store securestore.Store, runID string) (CredentialStorePoCResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	ref, err := securestore.NewSecretRef("poc", runID, "")
	if err != nil {
		return CredentialStorePoCResult{}, err
	}
	result := CredentialStorePoCResult{TargetName: ref.TargetName()}
	value, err := randomPoCSecret()
	if err != nil {
		return CredentialStorePoCResult{}, err
	}
	result.ValueSize = len(value)

	cleanup := func() {
		_ = store.Delete(context.Background(), ref)
	}

	if err := store.Put(ctx, ref, value); err != nil {
		return result, err
	}
	defer cleanup()

	got, err := store.Get(ctx, ref)
	if err != nil {
		return result, err
	}
	result.ReadBackOK = bytes.Equal(got, value)
	if !result.ReadBackOK {
		return result, fmt.Errorf("验证 Windows 凭据读回失败: %w", securestore.ErrSecretVerifyFailed)
	}

	if err := store.Delete(ctx, ref); err != nil {
		return result, err
	}
	if _, err := store.Get(ctx, ref); err == nil {
		return result, fmt.Errorf("验证 Windows 凭据删除失败: %w", securestore.ErrSecretVerifyFailed)
	} else if !errors.Is(err, securestore.ErrSecretNotFound) {
		return result, fmt.Errorf("验证 Windows 凭据删除失败: %w", err)
	}
	result.Deleted = true
	result.OK = true
	return result, nil
}

func randomPoCSecret() ([]byte, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return nil, fmt.Errorf("生成凭据 PoC 随机值失败: %w", err)
	}
	return []byte("secret-" + hex.EncodeToString(buf[:])), nil
}
