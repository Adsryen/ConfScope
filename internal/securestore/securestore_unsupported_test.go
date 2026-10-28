//go:build !windows && !darwin && !linux

package securestore

import (
	"context"
	"errors"
	"testing"
)

func TestCredentialManagerStoreReturnsUnsupportedOnUnimplementedPlatform(t *testing.T) {
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

func TestLargeStoreReturnsUnsupportedOnUnimplementedPlatform(t *testing.T) {
	_, err := NewLargeStore("/tmp/confscope-test")
	if !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("NewLargeStore error = %v, want ErrUnsupportedPlatform", err)
	}
}
