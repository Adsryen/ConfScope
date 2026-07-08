package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"

	"confscope/internal/securestore"
)

// CredentialStorePoCResult 是凭据库最小 PoC 的非敏感执行摘要。
type CredentialStorePoCResult struct {
	OK         bool   `json:"ok"`
	TargetName string `json:"targetName"`
	ReadBackOK bool   `json:"readBackOk"`
	Deleted    bool   `json:"deleted"`
	ValueSize  int    `json:"valueSize"`
}

// RunCredentialStorePoC 运行 Windows Credential Manager 最小 PoC。
//
// 该绑定只写入 ConfScope/poc/<run-id> 测试凭据，成功后立即删除；它不读取、
// 迁移或修改任何真实连接、SSH、WebDAV 凭据。
func (a *App) RunCredentialStorePoC(runID string) (CredentialStorePoCResult, error) {
	ctx := context.Background()
	if a.ctx != nil {
		ctx = a.ctx
	}
	return runCredentialStorePoC(ctx, securestore.NewCredentialManagerStore(), runID)
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
