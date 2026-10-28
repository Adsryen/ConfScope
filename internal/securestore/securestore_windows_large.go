//go:build windows

package securestore

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

// Windows 大 secret = DPAPI 加密文件（07-09-windows-large-secret-protection 既定路线）：
// 文件落在数据根 secure-large-secrets/<namespace>/<ownerID>/<field>.blob，
// 目录 0700、文件 0600，临时文件 + rename 原子写。
// DPAPI 绑定当前 Windows 用户，换机/清库后读回失败会走前端 missing 路径引导重填。

const (
	storageKindDPAPIFile = "dpapi-file"
	dpapiDirName         = "secure-large-secrets"
	cryptProtectUIForbid = 0x1
)

var (
	procCryptProtect   = syscall.NewLazyDLL("crypt32.dll").NewProc("CryptProtectData")
	procCryptUnprotect = syscall.NewLazyDLL("crypt32.dll").NewProc("CryptUnprotectData")
	procLocalFree      = syscall.NewLazyDLL("kernel32.dll").NewProc("LocalFree")
)

type dataBlob struct {
	cbData uint32
	pbData *byte
}

func blobPtr(value []byte) dataBlob {
	if len(value) == 0 {
		return dataBlob{}
	}
	return dataBlob{cbData: uint32(len(value)), pbData: &value[0]}
}

func dpapiProtect(value []byte) ([]byte, error) {
	in := blobPtr(value)
	var out dataBlob
	if r1, _, callErr := procCryptProtect.Call(
		uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0,
		uintptr(cryptProtectUIForbid),
		uintptr(unsafe.Pointer(&out)),
	); r1 == 0 {
		return nil, fmt.Errorf("DPAPI 加密失败: %w", callErr)
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.pbData)))
	return append([]byte(nil), unsafe.Slice(out.pbData, int(out.cbData))...), nil
}

func dpapiUnprotect(encrypted []byte) ([]byte, error) {
	in := blobPtr(encrypted)
	var out dataBlob
	if r1, _, callErr := procCryptUnprotect.Call(
		uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0,
		uintptr(cryptProtectUIForbid),
		uintptr(unsafe.Pointer(&out)),
	); r1 == 0 {
		return nil, fmt.Errorf("DPAPI 解密失败: %w", callErr)
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.pbData)))
	return append([]byte(nil), unsafe.Slice(out.pbData, int(out.cbData))...), nil
}

func largeSecretFilePath(dataDir string, ref LargeRef) string {
	return filepath.Join(dataDir, dpapiDirName, ref.Namespace, ref.OwnerID, ref.Field+".blob")
}

type dpapiFileStore struct {
	dataDir string
}

func newPlatformLargeStore(dataDir string) (LargeStore, error) {
	if filepath.Clean(dataDir) == "." || dataDir == "" {
		return nil, errors.New("大 secret 存储需要数据根目录")
	}
	return dpapiFileStore{dataDir: dataDir}, nil
}

func (s dpapiFileStore) StorageKind() string {
	return storageKindDPAPIFile
}

func (s dpapiFileStore) PutLarge(ctx context.Context, ref LargeRef, value []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ValidateLargeSecretValue(value); err != nil {
		return err
	}
	encrypted, err := dpapiProtect(value)
	if err != nil {
		return err
	}
	path := largeSecretFilePath(s.dataDir, ref)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("创建大 secret 目录失败: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".blob-tmp-*")
	if err != nil {
		return fmt.Errorf("创建大 secret 临时文件失败: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // rename 成功后此调用是 no-op
	if _, err := tmp.Write(encrypted); err != nil {
		tmp.Close()
		return fmt.Errorf("写入大 secret 临时文件失败: %w", err)
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("设置大 secret 文件权限失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("关闭大 secret 临时文件失败: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("落盘大 secret 失败: %w", err)
	}
	return nil
}

func (s dpapiFileStore) GetLarge(ctx context.Context, ref LargeRef) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(largeSecretFilePath(s.dataDir, ref))
	if errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("%w: %s", ErrSecretNotFound, ref.TargetName())
	}
	if err != nil {
		return nil, fmt.Errorf("读取大 secret 文件失败: %w", err)
	}
	plain, err := dpapiUnprotect(raw)
	if err != nil {
		return nil, err
	}
	return plain, nil
}

func (s dpapiFileStore) DeleteLarge(ctx context.Context, ref LargeRef) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	err := os.Remove(largeSecretFilePath(s.dataDir, ref))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("删除大 secret 文件失败: %w", err)
	}
	return nil
}
