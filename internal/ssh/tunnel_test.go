package ssh

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"strings"
	"testing"
)

func testPrivateKey(t *testing.T) string {
	t.Helper()

	key, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	block := &pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	}
	return string(pem.EncodeToMemory(block))
}

func TestCreateSSHConfigUsesPasswordAuth(t *testing.T) {
	tunnel := NewTunnel(Config{
		Username: "root",
		AuthType: "password",
		Password: "secret",
	})

	config, err := tunnel.createSSHConfig()
	if err != nil {
		t.Fatalf("createSSHConfig returned error: %v", err)
	}
	if config.User != "root" {
		t.Fatalf("User = %q, want root", config.User)
	}
	if len(config.Auth) != 1 {
		t.Fatalf("len(Auth) = %d, want 1", len(config.Auth))
	}
	if config.HostKeyCallback == nil {
		t.Fatal("HostKeyCallback is nil")
	}
}

func TestCreateSSHConfigRejectsUnsupportedAuthType(t *testing.T) {
	tunnel := NewTunnel(Config{
		Username: "root",
		AuthType: "agent",
	})

	_, err := tunnel.createSSHConfig()
	if err == nil {
		t.Fatal("createSSHConfig returned nil error")
	}
	if !strings.Contains(err.Error(), "unsupported auth type") {
		t.Fatalf("error = %q, want unsupported auth type", err.Error())
	}
}

func TestParsePrivateKeyWithoutPassphrase(t *testing.T) {
	tunnel := NewTunnel(Config{
		PrivateKey: testPrivateKey(t),
	})

	signer, err := tunnel.parsePrivateKey()
	if err != nil {
		t.Fatalf("parsePrivateKey returned error: %v", err)
	}
	if signer == nil {
		t.Fatal("signer is nil")
	}
}

func TestParsePrivateKeyReturnsErrorForInvalidKey(t *testing.T) {
	tunnel := NewTunnel(Config{
		PrivateKey: "not a private key",
	})

	_, err := tunnel.parsePrivateKey()
	if err == nil {
		t.Fatal("parsePrivateKey returned nil error")
	}
}

func TestStoppedTunnelCannotStart(t *testing.T) {
	tunnel := NewTunnel(Config{
		AuthType: "password",
	})
	tunnel.Stop()

	_, err := tunnel.Start()
	if err == nil {
		t.Fatal("Start returned nil error")
	}
	if !strings.Contains(err.Error(), "tunnel is closed") {
		t.Fatalf("error = %q, want tunnel is closed", err.Error())
	}
}
