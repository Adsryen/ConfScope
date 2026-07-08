//go:build windows

package securestore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestCredentialManagerStorePutGetDelete(t *testing.T) {
	ctx := context.Background()
	store := NewCredentialManagerStore()
	runID := fmt.Sprintf("test-%d", time.Now().UnixNano())
	ref, err := NewSecretRef("poc", runID, "")
	if err != nil {
		t.Fatalf("NewSecretRef returned error: %v", err)
	}
	t.Cleanup(func() {
		_ = store.Delete(ctx, ref)
	})

	first := []byte("secret-" + runID)
	if err := store.Put(ctx, ref, first); err != nil {
		t.Fatalf("Put first value returned error: %v", err)
	}
	got, err := store.Get(ctx, ref)
	if err != nil {
		t.Fatalf("Get first value returned error: %v", err)
	}
	if !bytes.Equal(got, first) {
		t.Fatalf("Get first value = %q, want %q", got, first)
	}

	second := []byte("updated-" + runID)
	if err := store.Put(ctx, ref, second); err != nil {
		t.Fatalf("Put second value returned error: %v", err)
	}
	got, err = store.Get(ctx, ref)
	if err != nil {
		t.Fatalf("Get second value returned error: %v", err)
	}
	if !bytes.Equal(got, second) {
		t.Fatalf("Get second value = %q, want %q", got, second)
	}

	if err := store.Delete(ctx, ref); err != nil {
		t.Fatalf("Delete returned error: %v", err)
	}
	if _, err := store.Get(ctx, ref); !errors.Is(err, ErrSecretNotFound) {
		t.Fatalf("Get after delete error = %v, want ErrSecretNotFound", err)
	}
}
