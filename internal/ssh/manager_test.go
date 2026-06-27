package ssh

import (
	"strings"
	"testing"
)

func TestManagerReturnsErrorForMissingTunnelPort(t *testing.T) {
	manager := NewManager()

	_, err := manager.GetLocalPort("missing")
	if err == nil {
		t.Fatal("GetLocalPort returned nil error")
	}
	if !strings.Contains(err.Error(), "no tunnel found") {
		t.Fatalf("error = %q, want missing tunnel error", err.Error())
	}
}

func TestManagerGetTunnelReturnsNilForMissingTunnel(t *testing.T) {
	manager := NewManager()

	if got := manager.GetTunnel("missing"); got != nil {
		t.Fatalf("GetTunnel returned %#v, want nil", got)
	}
}

func TestManagerStopTunnelIsIdempotent(t *testing.T) {
	manager := NewManager()

	manager.StopTunnel("missing")
	manager.StopTunnel("missing")
}

func TestManagerStopAllIsIdempotent(t *testing.T) {
	manager := NewManager()

	manager.StopAll()
	manager.StopAll()
}

func TestManagerDoesNotStoreTunnelWhenStartFails(t *testing.T) {
	manager := NewManager()

	_, err := manager.CreateTunnel("conn", Config{
		Host:       "127.0.0.1",
		Port:       1,
		Username:   "root",
		AuthType:   "unsupported",
		RemoteHost: "localhost",
		RemotePort: 8848,
	})
	if err == nil {
		t.Fatal("CreateTunnel returned nil error")
	}
	if got := manager.GetTunnel("conn"); got != nil {
		t.Fatalf("GetTunnel returned %#v after failed start, want nil", got)
	}
}
