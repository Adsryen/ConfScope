package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"testing"

	"confscope/internal/securestore"
)

type fakeSecureStore struct {
	values       map[string][]byte
	readOverride []byte
	putErr       error
	getErr       error
	deleteErr    error
	deleted      []string
}

func newFakeSecureStore() *fakeSecureStore {
	return &fakeSecureStore{values: map[string][]byte{}}
}

func (s *fakeSecureStore) Put(_ context.Context, ref securestore.SecretRef, value []byte) error {
	if s.putErr != nil {
		return s.putErr
	}
	s.values[ref.TargetName()] = append([]byte(nil), value...)
	return nil
}

func (s *fakeSecureStore) Get(_ context.Context, ref securestore.SecretRef) ([]byte, error) {
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

func (s *fakeSecureStore) Delete(_ context.Context, ref securestore.SecretRef) error {
	if s.deleteErr != nil {
		return s.deleteErr
	}
	delete(s.values, ref.TargetName())
	s.deleted = append(s.deleted, ref.TargetName())
	return nil
}

func TestWriteSecureSecretVerifiesReadBackAndDoesNotExposeValue(t *testing.T) {
	store := newFakeSecureStore()
	ref := SecureSecretRef{Namespace: "connection", OwnerID: "conn-1", Field: "password"}

	result, err := runWriteSecureSecret(context.Background(), store, ref, "nacos-pass")
	if err != nil {
		t.Fatalf("runWriteSecureSecret returned error: %v", err)
	}

	if !result.Verified {
		t.Fatal("result.Verified = false, want true")
	}
	if got, want := result.TargetName, "ConfScope/connection/conn-1/password"; got != want {
		t.Fatalf("TargetName = %q, want %q", got, want)
	}
	if got, want := result.ValueSize, len("nacos-pass"); got != want {
		t.Fatalf("ValueSize = %d, want %d", got, want)
	}
	if fmt.Sprintf("%+v", result) == "nacos-pass" || bytes.Contains([]byte(fmt.Sprintf("%+v", result)), []byte("nacos-pass")) {
		t.Fatalf("result leaks secret: %+v", result)
	}
	if got := string(store.values[result.TargetName]); got != "nacos-pass" {
		t.Fatalf("stored value = %q, want secret", got)
	}
}

func TestWriteSecureSecretDeletesValueWhenReadBackDiffers(t *testing.T) {
	store := newFakeSecureStore()
	store.readOverride = []byte("wrong-secret")
	ref := SecureSecretRef{Namespace: "connection", OwnerID: "conn-1", Field: "apolloToken"}

	_, err := runWriteSecureSecret(context.Background(), store, ref, "apollo-token")

	if !errors.Is(err, securestore.ErrSecretVerifyFailed) {
		t.Fatalf("runWriteSecureSecret error = %v, want ErrSecretVerifyFailed", err)
	}
	target := "ConfScope/connection/conn-1/apolloToken"
	if _, ok := store.values[target]; ok {
		t.Fatalf("stored value for %s still exists after failed verification", target)
	}
	if len(store.deleted) != 1 || store.deleted[0] != target {
		t.Fatalf("deleted = %v, want [%s]", store.deleted, target)
	}
}

func TestReadAndDeleteSecureSecretUseStructuredRef(t *testing.T) {
	store := newFakeSecureStore()
	ref := SecureSecretRef{Namespace: "snapshot-webdav", OwnerID: "default", Field: "password"}
	secretRef, err := securestore.NewSecretRef(ref.Namespace, ref.OwnerID, ref.Field)
	if err != nil {
		t.Fatalf("NewSecretRef returned error: %v", err)
	}
	if err := store.Put(context.Background(), secretRef, []byte("webdav-pass")); err != nil {
		t.Fatalf("Put returned error: %v", err)
	}

	value, err := runReadSecureSecret(context.Background(), store, ref)
	if err != nil {
		t.Fatalf("runReadSecureSecret returned error: %v", err)
	}
	if value != "webdav-pass" {
		t.Fatalf("value = %q, want webdav-pass", value)
	}
	if err := runDeleteSecureSecret(context.Background(), store, ref); err != nil {
		t.Fatalf("runDeleteSecureSecret returned error: %v", err)
	}
	if _, err := store.Get(context.Background(), secretRef); !errors.Is(err, securestore.ErrSecretNotFound) {
		t.Fatalf("Get after delete error = %v, want ErrSecretNotFound", err)
	}
}
