package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"confscope/internal/securestore"
)

type fakeLargeStore struct {
	values       map[string][]byte
	kind         string
	putErr       error
	getErr       error
	deleteErr    error
	readOverride []byte
	deleted      []string
}

func newFakeLargeStore(kind string) *fakeLargeStore {
	return &fakeLargeStore{values: map[string][]byte{}, kind: kind}
}

func (s *fakeLargeStore) PutLarge(_ context.Context, ref securestore.LargeRef, value []byte) error {
	if s.putErr != nil {
		return s.putErr
	}
	s.values[ref.TargetName()] = append([]byte(nil), value...)
	return nil
}

func (s *fakeLargeStore) GetLarge(_ context.Context, ref securestore.LargeRef) ([]byte, error) {
	if s.getErr != nil {
		return nil, s.getErr
	}
	if s.readOverride != nil {
		return append([]byte(nil), s.readOverride...), nil
	}
	value, ok := s.values[ref.TargetName()]
	if !ok {
		return nil, securestore.ErrSecretNotFound
	}
	return append([]byte(nil), value...), nil
}

func (s *fakeLargeStore) DeleteLarge(_ context.Context, ref securestore.LargeRef) error {
	if s.deleteErr != nil {
		return s.deleteErr
	}
	delete(s.values, ref.TargetName())
	s.deleted = append(s.deleted, ref.TargetName())
	return nil
}

func (s *fakeLargeStore) StorageKind() string {
	return s.kind
}

func largeTestRef() LargeSecretRef {
	return LargeSecretRef{Namespace: "connection-ssh", OwnerID: "conn-1", Field: "privateKey"}
}

const largeTestKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----"

func TestWriteLargeSecretVerifiesReadBackAndDoesNotExposeValue(t *testing.T) {
	store := newFakeLargeStore("dpapi-file")
	ref := largeTestRef()

	result, err := runWriteLargeSecret(context.Background(), store, ref, largeTestKey)
	if err != nil {
		t.Fatalf("runWriteLargeSecret returned error: %v", err)
	}
	if !result.Verified {
		t.Fatal("result.Verified = false, want true")
	}
	if got, want := result.Storage, "dpapi-file"; got != want {
		t.Fatalf("result.Storage = %q, want %q", got, want)
	}
	if got, want := result.ValueSize, len(largeTestKey); got != want {
		t.Fatalf("result.ValueSize = %d, want %d", got, want)
	}
	if got := result.Ref; got != ref {
		t.Fatalf("result.Ref = %#v, want %#v", got, ref)
	}
	if len(store.values) != 1 {
		t.Fatalf("store holds %d values, want 1", len(store.values))
	}
}

func TestWriteLargeSecretDeletesValueWhenReadBackDiffers(t *testing.T) {
	store := newFakeLargeStore("secret-service")
	store.readOverride = []byte("tampered")

	_, err := runWriteLargeSecret(context.Background(), store, largeTestRef(), largeTestKey)
	if !errors.Is(err, securestore.ErrSecretVerifyFailed) {
		t.Fatalf("error = %v, want ErrSecretVerifyFailed", err)
	}
	if len(store.deleted) != 1 {
		t.Fatalf("deleted = %v, want 1 entry", store.deleted)
	}
	if len(store.values) != 0 {
		t.Fatalf("store still holds %d values, want 0", len(store.values))
	}
}

func TestWriteLargeSecretTooLargeGivesReadableError(t *testing.T) {
	store := newFakeLargeStore("dpapi-file")
	store.putErr = fmt.Errorf("simulated put: %w", securestore.ErrSecretTooLarge)

	_, err := runWriteLargeSecret(context.Background(), store, largeTestRef(), largeTestKey)
	if !errors.Is(err, securestore.ErrSecretTooLarge) {
		t.Fatalf("error = %v, want wrap of ErrSecretTooLarge", err)
	}
	for _, want := range []string{"未迁移", "明文保留原样"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error message = %q, want it to contain %q", err.Error(), want)
		}
	}
}

func TestWriteLargeSecretRejectsInvalidRefBeforeTouchingStore(t *testing.T) {
	store := newFakeLargeStore("keychain")

	_, err := runWriteLargeSecret(context.Background(), store,
		LargeSecretRef{Namespace: "connection", OwnerID: "conn-1", Field: "password"}, "x")
	if !errors.Is(err, securestore.ErrInvalidSecretRef) {
		t.Fatalf("error = %v, want ErrInvalidSecretRef", err)
	}
	if len(store.values) != 0 || len(store.deleted) != 0 {
		t.Fatal("store must stay untouched for invalid ref")
	}
}

func TestReadAndDeleteLargeSecretUseStructuredRef(t *testing.T) {
	store := newFakeLargeStore("secret-service")
	ref := LargeSecretRef{Namespace: "ssh-profile", OwnerID: "profile-9", Field: "passphrase"}

	if _, err := runWriteLargeSecret(context.Background(), store, ref, "ph-123"); err != nil {
		t.Fatalf("runWriteLargeSecret returned error: %v", err)
	}

	got, err := runReadLargeSecret(context.Background(), store, ref)
	if err != nil {
		t.Fatalf("runReadLargeSecret returned error: %v", err)
	}
	if got != "ph-123" {
		t.Fatalf("read = %q, want %q", got, "ph-123")
	}

	if err := runDeleteLargeSecret(context.Background(), store, ref); err != nil {
		t.Fatalf("runDeleteLargeSecret returned error: %v", err)
	}
	if err := runDeleteLargeSecret(context.Background(), store, ref); err != nil {
		t.Fatalf("second runDeleteLargeSecret not idempotent: %v", err)
	}
	if _, err := runReadLargeSecret(context.Background(), store, ref); !errors.Is(err, securestore.ErrSecretNotFound) {
		t.Fatalf("read after delete = %v, want ErrSecretNotFound", err)
	}
}
