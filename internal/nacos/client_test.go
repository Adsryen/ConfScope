package nacos

import (
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

func TestLoginParsesBareV1Response(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/auth/login" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatalf("ParseForm: %v", err)
		}
		if r.Form.Get("username") != "nacos" || r.Form.Get("password") != "secret" {
			t.Fatalf("unexpected form: %v", r.Form)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"accessToken":"v1-token","tokenTtl":18000,"globalAdmin":false}`))
	}))

	result, err := NewClient().Login(server.URL, "nacos", "secret", "v1")
	if err != nil {
		t.Fatalf("Login returned error: %v", err)
	}
	if result.AccessToken != "v1-token" || result.TokenTtl != 18000 || result.GlobalAdmin {
		t.Fatalf("unexpected login result: %+v", result)
	}
}

func TestLoginReturnsForbiddenAsCredentialError(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`forbidden`))
	}))

	_, err := NewClient().Login(server.URL, "nacos", "bad", "v1")
	if err == nil {
		t.Fatal("Login returned nil error")
	}
	if !strings.Contains(err.Error(), "账号或密码错误") {
		t.Fatalf("error = %q, want credential hint", err.Error())
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

func TestNamespacesMapsV3Envelope(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/console/core/namespace/list" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("accessToken") != "token" {
			t.Fatalf("missing accessToken header")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":[{"namespaceId":"ns-a","namespaceShowName":"Namespace A","configCount":7,"type":2}]}`))
	}))

	namespaces, err := NewClient().Namespaces(server.URL, "token", "v3")
	if err != nil {
		t.Fatalf("Namespaces returned error: %v", err)
	}
	if len(namespaces) != 1 {
		t.Fatalf("len(namespaces) = %d, want 1", len(namespaces))
	}
	got := namespaces[0]
	if got.Namespace != "ns-a" || got.NamespaceShowName != "Namespace A" || got.ConfigCount != 7 || got.Kind != 2 {
		t.Fatalf("unexpected namespace: %+v", got)
	}
}

func TestListConfigsMapsV3Response(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/console/cs/config/list" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("accessToken") != "token" {
			t.Fatalf("missing accessToken header")
		}
		q := r.URL.Query()
		if q.Get("namespaceId") != "ns" || q.Get("groupName") != "GROUP" || q.Get("dataId") != "app" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":{"totalCount":1,"pageNumber":2,"pagesAvailable":3,"pageItems":[{"dataId":"app.yaml","groupName":"GROUP","content":"a: 1","type":"yaml"}]}}`))
	}))

	page, err := NewClient().ListConfigs(server.URL, "token", "v3", "ns", "app", "GROUP", 2, 50)
	if err != nil {
		t.Fatalf("ListConfigs returned error: %v", err)
	}
	if page.TotalCount != 1 || page.PageNumber != 2 || page.PagesAvailable != 3 || len(page.PageItems) != 1 {
		t.Fatalf("unexpected page: %+v", page)
	}
	item := page.PageItems[0]
	if item.DataId != "app.yaml" || item.Group != "GROUP" || item.Content != "a: 1" || item.ConfigType != "yaml" {
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

func TestGetConfigUsesV1TextResponseAndTokenQuery(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/cs/configs" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("tenant") != "public" || q.Get("group") != "DEFAULT_GROUP" || q.Get("dataId") != "app.yaml" || q.Get("accessToken") != "token" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		_, _ = w.Write([]byte("plain: true"))
	}))

	content, err := NewClient().GetConfig(server.URL, "token", "v1", "public", "app.yaml", "DEFAULT_GROUP")
	if err != nil {
		t.Fatalf("GetConfig returned error: %v", err)
	}
	if content != "plain: true" {
		t.Fatalf("content = %q", content)
	}
}

func TestHistoryListMapsV3Response(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/console/cs/history/list" {
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
		_, _ = w.Write([]byte(`{"code":0,"data":{"totalCount":1,"pageNumber":1,"pagesAvailable":1,"pageItems":[{"id":123,"dataId":"app.yaml","groupName":"GROUP","opType":"U","modifyTime":1710000000000}]}}`))
	}))

	page, err := NewClient().HistoryList(server.URL, "token", "v3", "ns", "app.yaml", "GROUP", 1, 20)
	if err != nil {
		t.Fatalf("HistoryList returned error: %v", err)
	}
	if page.TotalCount != 1 || len(page.PageItems) != 1 {
		t.Fatalf("unexpected page: %+v", page)
	}
	item := page.PageItems[0]
	if item.Id != "123" || item.DataId != "app.yaml" || item.Group != "GROUP" || item.OpType != "U" || item.LastModifiedTime != "1710000000000" {
		t.Fatalf("unexpected history item: %+v", item)
	}
}

func TestHistoryDetailMapsV1Response(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/cs/history" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("tenant") != "public" || q.Get("group") != "DEFAULT_GROUP" || q.Get("dataId") != "app.yaml" || q.Get("nid") != "42" || q.Get("accessToken") != "token" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"42","dataId":"app.yaml","group":"DEFAULT_GROUP","content":"a: 1","opType":"I","createdTime":"2024-01-01","lastModifiedTime":"2024-01-02"}`))
	}))

	detail, err := NewClient().HistoryDetail(server.URL, "token", "v1", "public", "app.yaml", "DEFAULT_GROUP", "42")
	if err != nil {
		t.Fatalf("HistoryDetail returned error: %v", err)
	}
	if detail.Id != "42" || detail.Content != "a: 1" || detail.CreatedTime != "2024-01-01" || detail.LastModifiedTime != "2024-01-02" {
		t.Fatalf("unexpected detail: %+v", detail)
	}
}

func TestPublishConfigUsesV1FormAndRequiresTrueResponse(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/v1/cs/configs" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("accessToken") != "token" {
			t.Fatalf("missing accessToken query")
		}
		if err := r.ParseForm(); err != nil {
			t.Fatalf("ParseForm: %v", err)
		}
		if r.Form.Get("tenant") != "public" || r.Form.Get("group") != "DEFAULT_GROUP" || r.Form.Get("dataId") != "app.yaml" || r.Form.Get("content") != "a: 1" || r.Form.Get("type") != "yaml" {
			t.Fatalf("unexpected form: %v", r.Form)
		}
		_, _ = w.Write([]byte("true"))
	}))

	err := NewClient().PublishConfig(server.URL, "token", "v1", "public", "app.yaml", "DEFAULT_GROUP", "a: 1", "yaml")
	if err != nil {
		t.Fatalf("PublishConfig returned error: %v", err)
	}
}

func TestPublishConfigReturnsV3BusinessError(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/console/cs/config" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("accessToken") != "token" {
			t.Fatalf("missing accessToken header")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":100,"message":"denied","data":false}`))
	}))

	err := NewClient().PublishConfig(server.URL, "token", "v3", "ns", "app.yaml", "GROUP", "a: 1", "yaml")
	if err == nil {
		t.Fatal("PublishConfig returned nil error")
	}
	if !strings.Contains(err.Error(), "denied") {
		t.Fatalf("error = %q, want denied", err.Error())
	}
}

func TestDeleteConfigUsesV3QueryAndTokenHeader(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Fatalf("method = %s, want DELETE", r.Method)
		}
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
		_, _ = w.Write([]byte(`{"code":0,"message":"success","data":true}`))
	}))

	err := NewClient().DeleteConfig(server.URL, "token", "v3", "ns", "app.yaml", "GROUP")
	if err != nil {
		t.Fatalf("DeleteConfig returned error: %v", err)
	}
}

func TestV3EnvelopeBusinessErrorIsReturned(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":403,"message":"no permission","data":null}`))
	}))

	_, err := NewClient().Namespaces(server.URL, "token", "v3")
	if err == nil {
		t.Fatal("Namespaces returned nil error")
	}
	if !strings.Contains(err.Error(), "code=403") || !strings.Contains(err.Error(), "no permission") {
		t.Fatalf("error = %q, want v3 business error", err.Error())
	}
}
