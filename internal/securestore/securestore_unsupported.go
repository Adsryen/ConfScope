//go:build !windows && !darwin && !linux

package securestore

import (
	"context"
)

// 尚未实现系统凭据库的平台（Windows/macOS/Linux 之外）：如实报不支持。

type unsupportedCredentialManagerStore struct{}

func newPlatformCredentialManagerStore() Store {
	return unsupportedCredentialManagerStore{}
}

func newPlatformLargeStore(string) (LargeStore, error) {
	return nil, ErrUnsupportedPlatform
}

func (unsupportedCredentialManagerStore) Put(context.Context, SecretRef, []byte) error {
	return ErrUnsupportedPlatform
}

func (unsupportedCredentialManagerStore) Get(context.Context, SecretRef) ([]byte, error) {
	return nil, ErrUnsupportedPlatform
}

func (unsupportedCredentialManagerStore) Delete(context.Context, SecretRef) error {
	return ErrUnsupportedPlatform
}
