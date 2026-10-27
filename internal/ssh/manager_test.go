package ssh

import (
	"path/filepath"
	"strings"
	"testing"
)

// testKnownHostsPath 给单测一个稳定的 known_hosts 位置：
// 这些用例不碰主机密钥裁决本身，只需路径可解析。
func testKnownHostsPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "known_hosts")
}

func TestManagerReturnsErrorForMissingTunnelPort(t *testing.T) {
	manager := NewManager(func() string { return testKnownHostsPath(t) })

	_, err := manager.GetLocalPort("missing")
	if err == nil {
		t.Fatal("GetLocalPort returned nil error")
	}
	if !strings.Contains(err.Error(), "no tunnel found") {
		t.Fatalf("error = %q, want missing tunnel error", err.Error())
	}
}

func TestManagerGetTunnelReturnsNilForMissingTunnel(t *testing.T) {
	manager := NewManager(func() string { return testKnownHostsPath(t) })

	if got := manager.GetTunnel("missing"); got != nil {
		t.Fatalf("GetTunnel returned %#v, want nil", got)
	}
}

func TestManagerStopTunnelIsIdempotent(t *testing.T) {
	manager := NewManager(func() string { return testKnownHostsPath(t) })

	manager.StopTunnel("missing")
	manager.StopTunnel("missing")
}

func TestManagerStopAllIsIdempotent(t *testing.T) {
	manager := NewManager(func() string { return testKnownHostsPath(t) })

	manager.StopAll()
	manager.StopAll()
}

func TestManagerDoesNotStoreTunnelWhenStartFails(t *testing.T) {
	manager := NewManager(func() string { return testKnownHostsPath(t) })

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
	manager := NewManager(func() string { return testKnownHostsPath(t) })
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
