//go:build !windows

package securestore

import (
	"context"
	"errors"
	"testing"
)

func TestCredentialManagerStoreReturnsUnsupportedOnNonWindows(t *testing.T) {
	store := NewCredentialManagerStore()
	ref, err := NewSecretRef("poc", "unsupported-test", "")
	if err != nil {
		t.Fatalf("NewSecretRef returned error: %v", err)
	}

	if err := store.Put(context.Background(), ref, []byte("secret")); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Put error = %v, want ErrUnsupportedPlatform", err)
	}
	if _, err := store.Get(context.Background(), ref); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Get error = %v, want ErrUnsupportedPlatform", err)
	}
	if err := store.Delete(context.Background(), ref); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("Delete error = %v, want ErrUnsupportedPlatform", err)
	}
}
