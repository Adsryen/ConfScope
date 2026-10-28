//go:build darwin

package securestore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// macOS 系统凭据库 = Keychain，走 /usr/bin/security 命令行（R1 选型：
// 不引 cgo Security.framework，CI 双 arch 出包不需要额外原生依赖链）。
// 值一律走 stdin 或 stdout，绝不进 argv（argv 会留在 ps 与崩溃报告里）。
// 退出码 44 = errSecItemNotFound。

const (
	storageKindKeychain = "keychain"

	keychainSecurityBinary = "/usr/bin/security"
	keychainAccount        = "confscope"

	keychainErrSecItemNotFound = 44
)

var errKeychainItemNotFound = errors.New("keychain item not found")

func runKeychainSecurity(args []string, stdinValue []byte) ([]byte, error) {
	cmd := exec.Command(keychainSecurityBinary, args...)
	if stdinValue != nil {
		cmd.Stdin = bytes.NewReader(stdinValue)
	}
	out, err := cmd.Output()
	if err == nil {
		return out, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == keychainErrSecItemNotFound {
		return nil, errKeychainItemNotFound
	}
	detail := strings.TrimSpace(string(exitErrStderr(err)))
	if detail == "" {
		detail = err.Error()
	}
	return nil, fmt.Errorf("%s %s: %s", keychainSecurityBinary, strings.Join(args, " "), detail)
}

// exitErrStderr 只取 stderr（诊断文本，不含凭据值）。
func exitErrStderr(err error) []byte {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.Stderr
	}
	return nil
}

func keychainTarget(ref string) []string {
	return []string{"-s", ref, "-a", keychainAccount}
}

type keychainStore struct{}

func newPlatformCredentialManagerStore() Store {
	return keychainStore{}
}

func newPlatformLargeStore(_ string) (LargeStore, error) {
	return keychainStore{}, nil
}

func (keychainStore) StorageKind() string {
	return storageKindKeychain
}

func (keychainStore) Put(ctx context.Context, ref SecretRef, value []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ValidateSecretValue(value); err != nil {
		return err
	}
	args := append([]string{"add-generic-password", "-U"}, keychainTarget(ref.TargetName())...)
	args = append(args, "-w") // -w 无参：值从 stdin 读
	if _, err := runKeychainSecurity(args, value); err != nil {
		return fmt.Errorf("写入 macOS 钥匙串失败: %w", err)
	}
	return nil
}

func (keychainStore) Get(ctx context.Context, ref SecretRef) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	args := append([]string{"find-generic-password"}, keychainTarget(ref.TargetName())...)
	args = append(args, "-w")
	out, err := runKeychainSecurity(args, nil)
	if err != nil {
		if errors.Is(err, errKeychainItemNotFound) {
			return nil, fmt.Errorf("%w: %s", ErrSecretNotFound, ref.TargetName())
		}
		return nil, fmt.Errorf("读取 macOS 钥匙串失败: %w", err)
	}
	return out, nil
}

func (keychainStore) Delete(ctx context.Context, ref SecretRef) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	args := append([]string{"delete-generic-password"}, keychainTarget(ref.TargetName())...)
	if _, err := runKeychainSecurity(args, nil); err != nil {
		if errors.Is(err, errKeychainItemNotFound) {
			return nil
		}
		return fmt.Errorf("删除 macOS 钥匙串失败: %w", err)
	}
	return nil
}

func (keychainStore) PutLarge(ctx context.Context, ref LargeRef, value []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ValidateLargeSecretValue(value); err != nil {
		return err
	}
	args := append([]string{"add-generic-password", "-U"}, keychainTarget(ref.TargetName())...)
	args = append(args, "-w")
	if _, err := runKeychainSecurity(args, value); err != nil {
		return fmt.Errorf("写入 macOS 钥匙串失败: %w", err)
	}
	return nil
}

func (keychainStore) GetLarge(ctx context.Context, ref LargeRef) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	args := append([]string{"find-generic-password"}, keychainTarget(ref.TargetName())...)
	args = append(args, "-w")
	out, err := runKeychainSecurity(args, nil)
	if err != nil {
		if errors.Is(err, errKeychainItemNotFound) {
			return nil, fmt.Errorf("%w: %s", ErrSecretNotFound, ref.TargetName())
		}
		return nil, fmt.Errorf("读取 macOS 钥匙串失败: %w", err)
	}
	return out, nil
}

func (keychainStore) DeleteLarge(ctx context.Context, ref LargeRef) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	args := append([]string{"delete-generic-password"}, keychainTarget(ref.TargetName())...)
	if _, err := runKeychainSecurity(args, nil); err != nil {
		if errors.Is(err, errKeychainItemNotFound) {
			return nil
		}
		return fmt.Errorf("删除 macOS 钥匙串失败: %w", err)
	}
	return nil
}
