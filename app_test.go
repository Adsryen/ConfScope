package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"confscope/internal/updatecheck"
)

func newAppIPv4Server(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()

	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen tcp4: %v", err)
	}

	server := httptest.NewUnstartedServer(handler)
	server.Listener = listener
	server.Start()
	t.Cleanup(server.Close)
	return server
}

func TestGetAppInfoReturnsVersionAndDefaultUpdateSources(t *testing.T) {
	info := NewApp().GetAppInfo()

	if info.Name != "ConfScope" {
		t.Fatalf("Name = %q, want ConfScope", info.Name)
	}
	if info.Version == "" {
		t.Fatal("Version is empty")
	}
	if len(info.UpdateSources) < 3 {
		t.Fatalf("len(UpdateSources) = %d, want at least 3", len(info.UpdateSources))
	}
}

func TestCheckForUpdatesUsesAppVersionWhenCurrentVersionIsEmpty(t *testing.T) {
	server := newAppIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"version":"9.9.9",
			"downloadUrl":"https://download.example.com/ConfScope.exe"
		}`))
	}))

	result := NewApp().CheckForUpdates(updatecheck.Request{
		Sources: []updatecheck.Source{
			{Name: "test", URL: server.URL + "/update.json"},
		},
	})

	if result.CurrentVersion == "" {
		t.Fatal("CurrentVersion is empty")
	}
	if !result.HasUpdate || result.LatestVersion != "9.9.9" {
		t.Fatalf("unexpected result: %+v", result)
	}
}
