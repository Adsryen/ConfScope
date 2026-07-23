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

func TestManagerReusesExistingTunnelForSameConfig(t *testing.T) {
	manager := NewManager()
	config := Config{
		Host:       "jump.example.com",
		Port:       22,
		Username:   "root",
		AuthType:   "password",
		Password:   "secret",
		RemoteHost: "nacos.internal",
		RemotePort: 8848,
	}
	manager.tunnels["conn"] = &Tunnel{config: config, localPort: 9677}

	port, err := manager.CreateTunnel("conn", config)
	if err != nil {
		t.Fatalf("CreateTunnel returned error: %v", err)
	}
	if port != 9677 {
		t.Fatalf("port = %d, want existing port 9677", port)
	}
	if got := manager.GetTunnel("conn"); got == nil || got.GetLocalPort() != 9677 {
		t.Fatalf("existing tunnel was not reused, got %#v", got)
	}
}
