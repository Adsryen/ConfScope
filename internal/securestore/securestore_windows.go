//go:build windows

package securestore

import (
	"context"
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

const (
	credTypeGeneric         = 1
	credPersistLocalMachine = 2
	credErrorNotFound       = syscall.Errno(1168)
)

var (
	advapi32       = syscall.NewLazyDLL("advapi32.dll")
	procCredWrite  = advapi32.NewProc("CredWriteW")
	procCredRead   = advapi32.NewProc("CredReadW")
	procCredDelete = advapi32.NewProc("CredDeleteW")
	procCredFree   = advapi32.NewProc("CredFree")
)

type filetime struct {
	LowDateTime  uint32
	HighDateTime uint32
}

type credentialW struct {
	Flags              uint32
	Type               uint32
	TargetName         *uint16
	Comment            *uint16
	LastWritten        filetime
	CredentialBlobSize uint32
	CredentialBlob     *byte
	Persist            uint32
	AttributeCount     uint32
	Attributes         uintptr
	TargetAlias        *uint16
	UserName           *uint16
}

type winCredentialManagerStore struct{}

func newPlatformCredentialManagerStore() Store {
	return winCredentialManagerStore{}
}

func (winCredentialManagerStore) Put(ctx context.Context, ref SecretRef, value []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := ValidateSecretValue(value); err != nil {
		return err
	}
	targetName, err := syscall.UTF16PtrFromString(ref.TargetName())
	if err != nil {
		return fmt.Errorf("创建凭据目标名失败: %w", err)
	}
	secret := append([]byte(nil), value...)
	var blob *byte
	if len(secret) > 0 {
		blob = &secret[0]
	}
	cred := credentialW{
		Type:               credTypeGeneric,
		TargetName:         targetName,
		CredentialBlobSize: uint32(len(secret)),
		CredentialBlob:     blob,
		Persist:            credPersistLocalMachine,
	}
	r1, _, callErr := procCredWrite.Call(uintptr(unsafe.Pointer(&cred)), 0)
	if r1 == 0 {
		return fmt.Errorf("写入 Windows 凭据失败: %w", callErr)
	}
	return nil
}

func (winCredentialManagerStore) Get(ctx context.Context, ref SecretRef) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	targetName, err := syscall.UTF16PtrFromString(ref.TargetName())
	if err != nil {
		return nil, fmt.Errorf("创建凭据目标名失败: %w", err)
	}
	var cred *credentialW
	r1, _, callErr := procCredRead.Call(
		uintptr(unsafe.Pointer(targetName)),
		uintptr(credTypeGeneric),
		0,
		uintptr(unsafe.Pointer(&cred)),
	)
	if r1 == 0 {
		return nil, mapWinCredError("读取 Windows 凭据失败", callErr)
	}
	defer procCredFree.Call(uintptr(unsafe.Pointer(cred)))

	if cred == nil || cred.CredentialBlobSize == 0 {
		return []byte{}, nil
	}
	value := unsafe.Slice(cred.CredentialBlob, int(cred.CredentialBlobSize))
	return append([]byte(nil), value...), nil
}

func (winCredentialManagerStore) Delete(ctx context.Context, ref SecretRef) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	targetName, err := syscall.UTF16PtrFromString(ref.TargetName())
	if err != nil {
		return fmt.Errorf("创建凭据目标名失败: %w", err)
	}
	r1, _, callErr := procCredDelete.Call(uintptr(unsafe.Pointer(targetName)), uintptr(credTypeGeneric), 0)
	if r1 == 0 {
		if errors.Is(callErr, credErrorNotFound) {
			return nil
		}
		return fmt.Errorf("删除 Windows 凭据失败: %w", callErr)
	}
	return nil
}

func mapWinCredError(context string, err error) error {
	if errors.Is(err, credErrorNotFound) {
		return fmt.Errorf("%w: %s", ErrSecretNotFound, context)
	}
	return fmt.Errorf("%s: %w", context, err)
}
