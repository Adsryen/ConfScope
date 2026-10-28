package securestore

import (
	"errors"
	"strings"
	"testing"
)

func TestNewLargeRefAcceptsExactSSHIdentities(t *testing.T) {
	cases := []struct {
		namespace string
		ownerID   string
		field     string
		target    string
	}{
		{namespace: "connection-ssh", ownerID: "conn-1", field: "password", target: "ConfScope/connection-ssh/conn-1/password"},
		{namespace: "connection-ssh", ownerID: "conn-1", field: "privateKey", target: "ConfScope/connection-ssh/conn-1/privateKey"},
		{namespace: "connection-ssh", ownerID: "c_abc123_x", field: "passphrase", target: "ConfScope/connection-ssh/c_abc123_x/passphrase"},
		{namespace: "ssh-profile", ownerID: "ssh_abc123", field: "privateKey", target: "ConfScope/ssh-profile/ssh_abc123/privateKey"},
	}

	for _, tc := range cases {
		ref, err := NewLargeRef(tc.namespace, tc.ownerID, tc.field)
		if err != nil {
			t.Fatalf("NewLargeRef(%q, %q, %q) returned error: %v", tc.namespace, tc.ownerID, tc.field, err)
		}
		if got := ref.TargetName(); got != tc.target {
			t.Fatalf("TargetName() = %q, want %q", got, tc.target)
		}
	}
}

func TestNewLargeRefRejectsForeignIdentities(t *testing.T) {
	cases := []struct {
		name      string
		namespace string
		ownerID   string
		field     string
	}{
		{name: "small credential namespace", namespace: "connection", ownerID: "conn-1", field: "password"},
		{name: "unknown namespace", namespace: "ssh", ownerID: "conn-1", field: "password"},
		{name: "empty namespace", namespace: "", ownerID: "conn-1", field: "password"},
		{name: "empty owner", namespace: "connection-ssh", ownerID: "", field: "password"},
		{name: "space owner", namespace: "connection-ssh", ownerID: "conn 1", field: "password"},
		{name: "slash owner", namespace: "connection-ssh", ownerID: "conn/1", field: "password"},
		{name: "unicode owner", namespace: "connection-ssh", ownerID: "conn-一", field: "password"},
		{name: "unknown field", namespace: "connection-ssh", ownerID: "conn-1", field: "token"},
		{name: "empty field", namespace: "connection-ssh", ownerID: "conn-1", field: ""},
		{name: "kebab field", namespace: "connection-ssh", ownerID: "conn-1", field: "private-key"},
		{name: "small store field", namespace: "ssh-profile", ownerID: "p-1", field: "accessKeyId"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewLargeRef(tc.namespace, tc.ownerID, tc.field)
			if !errors.Is(err, ErrInvalidSecretRef) {
				t.Fatalf("NewLargeRef error = %v, want ErrInvalidSecretRef", err)
			}
		})
	}
}

func TestValidateLargeSecretValueLimitsOneMiB(t *testing.T) {
	if err := ValidateLargeSecretValue(make([]byte, MaxLargeSecretSize)); err != nil {
		t.Fatalf("ValidateLargeSecretValue at limit returned error: %v", err)
	}
	err := ValidateLargeSecretValue(make([]byte, MaxLargeSecretSize+1))
	if !errors.Is(err, ErrSecretTooLarge) {
		t.Fatalf("ValidateLargeSecretValue over limit error = %v, want ErrSecretTooLarge", err)
	}
}

func TestSecretServiceUnavailableMessageMentionsUnsupported(t *testing.T) {
	if !strings.Contains(ErrSecretServiceUnavailable.Error(), "不支持") {
		t.Fatalf("ErrSecretServiceUnavailable message %q must contain 不支持 for frontend attribution", ErrSecretServiceUnavailable.Error())
	}
}
