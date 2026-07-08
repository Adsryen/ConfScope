//go:build !windows

package securestore

import (
	"context"
)

type unsupportedCredentialManagerStore struct{}

func newPlatformCredentialManagerStore() Store {
	return unsupportedCredentialManagerStore{}
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
