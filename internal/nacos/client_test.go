package nacos

import (
	"net/http"
	"net/http/httptest"
	"net"
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

func TestDetectVersionUsesV3WhenEndpointExists(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/console/core/namespace/list" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.WriteHeader(http.StatusForbidden)
	}))

	version, err := NewClient().DetectVersion(server.URL)
	if err != nil {
		t.Fatalf("DetectVersion returned error: %v", err)
	}
	if version != "v3" {
		t.Fatalf("version = %q, want v3", version)
	}
}

func TestDetectVersionFallsBackToV1On404(t *testing.T) {
	server := newIPv4Server(t, http.NotFoundHandler())

	version, err := NewClient().DetectVersion(server.URL)
	if err != nil {
		t.Fatalf("DetectVersion returned error: %v", err)
	}
	if version != "v1" {
		t.Fatalf("version = %q, want v1", version)
	}
}

func TestLoginParsesWrappedV3Response(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/auth/user/login" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatalf("ParseForm: %v", err)
		}
		if r.Form.Get("username") != "nacos" || r.Form.Get("password") != "secret" {
			t.Fatalf("unexpected form: %v", r.Form)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"accessToken":"abc","tokenTtl":18000,"globalAdmin":true}}`))
	}))

	result, err := NewClient().Login(server.URL, "nacos", "secret", "v3")
	if err != nil {
		t.Fatalf("Login returned error: %v", err)
	}
	if result.AccessToken != "abc" || result.TokenTtl != 18000 || !result.GlobalAdmin {
		t.Fatalf("unexpected login result: %+v", result)
	}
}

func TestListConfigsMapsV1Response(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/cs/configs" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("tenant") != "public" || q.Get("group") != "DEFAULT_GROUP" || q.Get("accessToken") != "token" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"totalCount":1,"pageNumber":1,"pagesAvailable":1,"pageItems":[{"dataId":"app.yaml","group":"DEFAULT_GROUP","content":"a: 1","type":"yaml"}]}`))
	}))

	page, err := NewClient().ListConfigs(server.URL, "token", "v1", "public", "app", "DEFAULT_GROUP", 1, 20)
	if err != nil {
		t.Fatalf("ListConfigs returned error: %v", err)
	}
	if page.TotalCount != 1 || len(page.PageItems) != 1 {
		t.Fatalf("unexpected page: %+v", page)
	}
	item := page.PageItems[0]
	if item.DataId != "app.yaml" || item.Group != "DEFAULT_GROUP" || item.Content != "a: 1" || item.ConfigType != "yaml" {
		t.Fatalf("unexpected item: %+v", item)
	}
}

func TestGetConfigUsesV3EnvelopeAndTokenHeader(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/console/cs/config" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("accessToken") != "token" {
			t.Fatalf("missing accessToken header")
		}
		q := r.URL.Query()
		if q.Get("namespaceId") != "ns" || q.Get("groupName") != "GROUP" || q.Get("dataId") != "app.yaml" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"message":"success","data":{"content":"server:\n  port: 8080"}}`))
	}))

	content, err := NewClient().GetConfig(server.URL, "token", "v3", "ns", "app.yaml", "GROUP")
	if err != nil {
		t.Fatalf("GetConfig returned error: %v", err)
	}
	if content != "server:\n  port: 8080" {
		t.Fatalf("content = %q", content)
	}
}
