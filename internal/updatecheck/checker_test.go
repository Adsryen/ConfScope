package updatecheck

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newIPv4Server(t *testing.T, handler http.Handler) *httptest.Server {
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

func TestCheckReportsNoUpdateWhenLatestIsCurrent(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"version":"1.0.0",
			"notes":"current release",
			"downloadUrl":"https://example.com/ConfScope.exe",
			"publishedAt":"2026-06-28T00:00:00Z",
			"sha256":"abc",
			"mandatory":false
		}`))
	}))

	result := Check(context.Background(), Request{
		CurrentVersion: "1.0.0",
		Sources: []Source{
			{Name: "official", URL: server.URL + "/update.json"},
		},
	})

	if result.Error != "" {
		t.Fatalf("Error = %q", result.Error)
	}
	if result.HasUpdate {
		t.Fatal("HasUpdate = true, want false")
	}
	if result.LatestVersion != "1.0.0" || result.SourceName != "official" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestCheckReportsUpdateAndRequiresHTTPSDownloadURL(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"version":"1.1.0",
			"notes":"new release",
			"downloadUrl":"https://download.example.com/ConfScope.exe",
			"publishedAt":"2026-06-28T00:00:00Z",
			"sha256":"def",
			"mandatory":true
		}`))
	}))

	result := Check(context.Background(), Request{
		CurrentVersion: "1.0.0",
		Sources: []Source{
			{Name: "official", URL: server.URL + "/update.json"},
		},
	})

	if result.Error != "" {
		t.Fatalf("Error = %q", result.Error)
	}
	if !result.HasUpdate {
		t.Fatal("HasUpdate = false, want true")
	}
	if result.LatestVersion != "1.1.0" || result.ReleaseNotes != "new release" || !result.Mandatory {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestCheckRejectsInsecureDownloadURL(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"version":"1.1.0",
			"downloadUrl":"http://download.example.com/ConfScope.exe"
		}`))
	}))

	result := Check(context.Background(), Request{
		CurrentVersion: "1.0.0",
		Sources: []Source{
			{Name: "official", URL: server.URL + "/update.json"},
		},
	})

	if result.Error == "" {
		t.Fatal("Error is empty, want HTTPS validation error")
	}
	if !strings.Contains(result.Error, "HTTPS") {
		t.Fatalf("Error = %q, want HTTPS hint", result.Error)
	}
}

func TestCheckReportsInvalidManifestError(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{bad json`))
	}))

	result := Check(context.Background(), Request{
		CurrentVersion: "1.0.0",
		Sources: []Source{
			{Name: "broken", URL: server.URL + "/update.json"},
		},
	})

	if result.Error == "" {
		t.Fatal("Error is empty, want manifest parse error")
	}
	if !strings.Contains(result.Error, "broken") {
		t.Fatalf("Error = %q, want source name", result.Error)
	}
}

func TestCheckFallsBackToDomesticMirrorSource(t *testing.T) {
	official := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad gateway", http.StatusBadGateway)
	}))
	mirror := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"version":"1.2.0",
			"notes":"mirror release",
			"downloadUrl":"https://mirror.example.com/ConfScope.exe"
		}`))
	}))

	result := Check(context.Background(), Request{
		CurrentVersion: "1.0.0",
		Sources: []Source{
			{Name: "GitHub", URL: official.URL + "/update.json"},
			{Name: "国内加速 1", URL: mirror.URL + "/update.json"},
		},
	})

	if result.Error != "" {
		t.Fatalf("Error = %q", result.Error)
	}
	if !result.HasUpdate || result.SourceName != "国内加速 1" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestCheckReturnsAggregatedErrorWhenAllSourcesFail(t *testing.T) {
	official := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad gateway", http.StatusBadGateway)
	}))
	mirror := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
	}))

	result := Check(context.Background(), Request{
		CurrentVersion: "1.0.0",
		Sources: []Source{
			{Name: "GitHub", URL: official.URL + "/update.json"},
			{Name: "国内加速 1", URL: mirror.URL + "/update.json"},
		},
	})

	if result.Error == "" {
		t.Fatal("Error is empty, want aggregated source errors")
	}
	if !strings.Contains(result.Error, "GitHub") || !strings.Contains(result.Error, "国内加速 1") {
		t.Fatalf("Error = %q, want both source names", result.Error)
	}
}

func TestCheckUsesGlobalProxyConfig(t *testing.T) {
	target := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("request should go through proxy, not target directly")
	}))
	proxy := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.String() != target.URL+"/update.json" {
			t.Fatalf("proxy saw URL %q", r.URL.String())
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"version":"1.1.0",
			"downloadUrl":"https://download.example.com/ConfScope.exe"
		}`))
	}))

	result := Check(context.Background(), Request{
		CurrentVersion: "1.0.0",
		Sources: []Source{
			{Name: "official", URL: target.URL + "/update.json"},
		},
		Proxy: ProxyConfig{
			HTTPProxy: proxy.URL,
		},
	})

	if result.Error != "" {
		t.Fatalf("Error = %q", result.Error)
	}
	if !result.HasUpdate {
		t.Fatal("HasUpdate = false, want true")
	}
}

func TestCheckBypassesProxyWhenNoProxyMatches(t *testing.T) {
	target := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"version":"1.1.0",
			"downloadUrl":"https://download.example.com/ConfScope.exe"
		}`))
	}))
	proxy := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("request should bypass proxy for no_proxy host")
	}))

	result := Check(context.Background(), Request{
		CurrentVersion: "1.0.0",
		Sources: []Source{
			{Name: "official", URL: target.URL + "/update.json"},
		},
		Proxy: ProxyConfig{
			HTTPProxy: proxy.URL,
			NoProxy:   "127.0.0.1",
		},
	})

	if result.Error != "" {
		t.Fatalf("Error = %q", result.Error)
	}
	if !result.HasUpdate {
		t.Fatal("HasUpdate = false, want true")
	}
}

func TestCompareVersionsHandlesVPrefixAndPrerelease(t *testing.T) {
	tests := []struct {
		a    string
		b    string
		want int
	}{
		{a: "v1.2.0", b: "1.1.9", want: 1},
		{a: "1.2.0", b: "1.2.0", want: 0},
		{a: "1.2.0-beta.1", b: "1.2.0", want: -1},
		{a: "1.10.0", b: "1.2.9", want: 1},
	}

	for _, tt := range tests {
		if got := CompareVersions(tt.a, tt.b); got != tt.want {
			t.Fatalf("CompareVersions(%q, %q) = %d, want %d", tt.a, tt.b, got, tt.want)
		}
	}
}
