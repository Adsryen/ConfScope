package securestore

import (
	"bytes"
	"errors"
	"testing"
)

func TestSecretRefTargetName(t *testing.T) {
	ref, err := NewSecretRef("poc", "run-123", "")
	if err != nil {
		t.Fatalf("NewSecretRef returned error: %v", err)
	}
	if got, want := ref.TargetName(), "ConfScope/poc/run-123"; got != want {
		t.Fatalf("TargetName() = %q, want %q", got, want)
	}

	fieldRef, err := NewSecretRef("connection", "conn-1", "password")
	if err != nil {
		t.Fatalf("NewSecretRef with field returned error: %v", err)
	}
	if got, want := fieldRef.TargetName(), "ConfScope/connection/conn-1/password"; got != want {
		t.Fatalf("TargetName() = %q, want %q", got, want)
	}
}

func TestNewSecretRefRejectsUnsafeParts(t *testing.T) {
	cases := []struct {
		name      string
		namespace string
		ownerID   string
		field     string
	}{
		{name: "empty namespace", namespace: "", ownerID: "owner", field: "password"},
		{name: "empty owner", namespace: "connection", ownerID: "", field: "password"},
		{name: "slash namespace", namespace: "conn/ection", ownerID: "owner", field: "password"},
		{name: "slash owner", namespace: "connection", ownerID: "owner/1", field: "password"},
		{name: "space field", namespace: "connection", ownerID: "owner", field: "pass word"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewSecretRef(tc.namespace, tc.ownerID, tc.field)
			if !errors.Is(err, ErrInvalidSecretRef) {
				t.Fatalf("NewSecretRef error = %v, want ErrInvalidSecretRef", err)
			}
		})
	}
}

func TestValidateSecretValueRejectsOversizedValue(t *testing.T) {
	value := bytes.Repeat([]byte("x"), MaxCredentialBlobSize+1)

	err := ValidateSecretValue(value)

	if !errors.Is(err, ErrSecretTooLarge) {
		t.Fatalf("ValidateSecretValue error = %v, want ErrSecretTooLarge", err)
	}
}
