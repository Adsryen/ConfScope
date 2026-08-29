package nacos

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
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

func TestTruncateKeepsFullResponseBody(t *testing.T) {
	body := strings.Repeat("x", 500)
	got := truncate("  " + body + "  ")
	if got != body {
		t.Fatalf("truncate length = %d, want %d", len(got), len(body))
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
		_, _ = w.Write([]byte(`{"code":0,"message":"success","data":{"content":"server:\n  port: 8080","md5":"abc123"}}`))
	}))

	result, err := NewClient().GetConfig(server.URL, "token", "v3", "ns", "app.yaml", "GROUP")
	if err != nil {
		t.Fatalf("GetConfig returned error: %v", err)
	}
	if result.Content != "server:\n  port: 8080" {
		t.Fatalf("content = %q", result.Content)
	}
	if result.Md5 != "abc123" {
		t.Fatalf("md5 = %q, want abc123", result.Md5)
	}
}

func TestGetConfigUsesV1TextResponseAndTokenQuery(t *testing.T) {
	seen := map[string]bool{}
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("tenant") != "public" || q.Get("group") != "DEFAULT_GROUP" || q.Get("dataId") != "app.yaml" || q.Get("accessToken") != "token" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		if q.Get("search") == "blur" {
			seen["list"] = true
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"totalCount":1,"pageItems":[{"dataId":"app.yaml","group":"DEFAULT_GROUP","type":"yaml","md5":"md5-v1-abc"}]}`))
			return
		}
		if r.URL.Path != "/v1/cs/configs" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		seen["get"] = true
		_, _ = w.Write([]byte("plain: true"))
	}))

	result, err := NewClient().GetConfig(server.URL, "token", "v1", "public", "app.yaml", "DEFAULT_GROUP")
	if err != nil {
		t.Fatalf("GetConfig returned error: %v", err)
	}
	if result.Content != "plain: true" {
		t.Fatalf("content = %q", result.Content)
	}
	if result.Md5 != "md5-v1-abc" {
		t.Fatalf("md5 = %q, want md5-v1-abc", result.Md5)
	}
	if !seen["list"] || !seen["get"] {
		t.Fatalf("expected both list and get requests, got %v", seen)
	}
}

func TestGetConfigDecodesGBKTextResponse(t *testing.T) {
	want := "app:\n  title: \u85aa\u706b\u5c31\u4e1a"
	gbk, err := simplifiedchinese.GBK.NewEncoder().Bytes([]byte(want))
	if err != nil {
		t.Fatalf("encode gbk: %v", err)
	}
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=GBK")
		_, _ = w.Write(gbk)
	}))

	result, err := NewClient().GetConfig(server.URL, "", "v1", "", "app.yaml", "DEFAULT_GROUP")
	if err != nil {
		t.Fatalf("GetConfig returned error: %v", err)
	}
	if result.Content != want {
		t.Fatalf("content = %q, want %q", result.Content, want)
	}
}

func TestGetConfigFallsBackToGB18030WithoutCharset(t *testing.T) {
	want := "message: \u4e2d\u6587\u914d\u7f6e"
	gb18030, err := simplifiedchinese.GB18030.NewEncoder().Bytes([]byte(want))
	if err != nil {
		t.Fatalf("encode gb18030: %v", err)
	}
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write(gb18030)
	}))

	result, err := NewClient().GetConfig(server.URL, "", "v1", "", "app.yaml", "DEFAULT_GROUP")
	if err != nil {
		t.Fatalf("GetConfig returned error: %v", err)
	}
	if result.Content != want {
		t.Fatalf("content = %q, want %q", result.Content, want)
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

func TestV1DefaultNamespaceOmitsTenantParameter(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := r.URL.Query()["tenant"]; ok {
			t.Fatalf("%s query includes tenant for default namespace: %s", r.Method, r.URL.RawQuery)
		}
		switch r.Method {
		case http.MethodGet:
			w.Header().Set("Content-Type", "application/json")
			switch r.URL.Path {
			case "/v1/cs/configs":
				if r.URL.Query().Get("search") == "blur" {
					_, _ = w.Write([]byte(`{"totalCount":1,"pageNumber":1,"pagesAvailable":1,"pageItems":[{"dataId":"app.yaml","group":"DEFAULT_GROUP","content":"a: 1","type":"yaml"}]}`))
					return
				}
				_, _ = w.Write([]byte("plain: true"))
			case "/v1/cs/history":
				if r.URL.Query().Get("nid") != "" {
					_, _ = w.Write([]byte(`{"id":"42","dataId":"app.yaml","group":"DEFAULT_GROUP","content":"a: 1","opType":"I","createdTime":"2024-01-01","lastModifiedTime":"2024-01-02"}`))
					return
				}
				_, _ = w.Write([]byte(`{"totalCount":1,"pageNumber":1,"pagesAvailable":1,"pageItems":[{"id":"42","dataId":"app.yaml","group":"DEFAULT_GROUP","opType":"I","lastModifiedTime":"2024-01-02"}]}`))
			default:
				t.Fatalf("unexpected path: %s", r.URL.Path)
			}
		case http.MethodPost:
			if err := r.ParseForm(); err != nil {
				t.Fatalf("ParseForm: %v", err)
			}
			if _, ok := r.PostForm["tenant"]; ok {
				t.Fatalf("POST form includes tenant for default namespace: %v", r.PostForm)
			}
			_, _ = w.Write([]byte("true"))
		case http.MethodDelete:
			if _, ok := r.URL.Query()["tenant"]; ok {
				t.Fatalf("DELETE query includes tenant for default namespace: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte("true"))
		default:
			t.Fatalf("unexpected method: %s", r.Method)
		}
	}))

	client := NewClient()
	if _, err := client.ListConfigs(server.URL, "", "v1", "", "app", "DEFAULT_GROUP", 1, 20); err != nil {
		t.Fatalf("ListConfigs returned error: %v", err)
	}
	if err := client.PublishConfig(server.URL, "", "v1", "", "app.yaml", "DEFAULT_GROUP", "a: 1", "yaml"); err != nil {
		t.Fatalf("PublishConfig returned error: %v", err)
	}
	if _, err := client.GetConfig(server.URL, "", "v1", "", "app.yaml", "DEFAULT_GROUP"); err != nil {
		t.Fatalf("GetConfig returned error: %v", err)
	}
	if _, err := client.HistoryList(server.URL, "", "v1", "", "app.yaml", "DEFAULT_GROUP", 1, 20); err != nil {
		t.Fatalf("HistoryList returned error: %v", err)
	}
	if _, err := client.HistoryDetail(server.URL, "", "v1", "", "app.yaml", "DEFAULT_GROUP", "42"); err != nil {
		t.Fatalf("HistoryDetail returned error: %v", err)
	}
	if err := client.DeleteConfig(server.URL, "", "v1", "", "app.yaml", "DEFAULT_GROUP"); err != nil {
		t.Fatalf("DeleteConfig returned error: %v", err)
	}
}

func TestV3DefaultNamespaceOmitsNamespaceIDParameter(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := r.URL.Query()["namespaceId"]; ok {
			t.Fatalf("%s query includes namespaceId for default namespace: %s", r.Method, r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodGet:
			switch r.URL.Path {
			case "/v3/console/cs/config/list":
				_, _ = w.Write([]byte(`{"code":0,"data":{"totalCount":1,"pageNumber":1,"pagesAvailable":1,"pageItems":[{"dataId":"app.yaml","groupName":"DEFAULT_GROUP","content":"a: 1","type":"yaml"}]}}`))
			case "/v3/console/cs/config":
				_, _ = w.Write([]byte(`{"code":0,"data":{"content":"plain: true"}}`))
			case "/v3/console/cs/history/list":
				_, _ = w.Write([]byte(`{"code":0,"data":{"totalCount":1,"pageNumber":1,"pagesAvailable":1,"pageItems":[{"id":"42","dataId":"app.yaml","groupName":"DEFAULT_GROUP","opType":"I","modifyTime":"2024-01-02"}]}}`))
			case "/v3/console/cs/history":
				_, _ = w.Write([]byte(`{"code":0,"data":{"id":"42","dataId":"app.yaml","groupName":"DEFAULT_GROUP","content":"a: 1","opType":"I","createTime":"2024-01-01","modifyTime":"2024-01-02"}}`))
			default:
				t.Fatalf("unexpected path: %s", r.URL.Path)
			}
		case http.MethodPost:
			if err := r.ParseForm(); err != nil {
				t.Fatalf("ParseForm: %v", err)
			}
			if _, ok := r.PostForm["namespaceId"]; ok {
				t.Fatalf("POST form includes namespaceId for default namespace: %v", r.PostForm)
			}
			_, _ = w.Write([]byte(`{"code":0,"data":true}`))
		case http.MethodDelete:
			_, _ = w.Write([]byte(`{"code":0,"data":true}`))
		default:
			t.Fatalf("unexpected method: %s", r.Method)
		}
	}))

	client := NewClient()
	if _, err := client.ListConfigs(server.URL, "", "v3", "", "app", "DEFAULT_GROUP", 1, 20); err != nil {
		t.Fatalf("ListConfigs returned error: %v", err)
	}
	if err := client.PublishConfig(server.URL, "", "v3", "", "app.yaml", "DEFAULT_GROUP", "a: 1", "yaml"); err != nil {
		t.Fatalf("PublishConfig returned error: %v", err)
	}
	if _, err := client.GetConfig(server.URL, "", "v3", "", "app.yaml", "DEFAULT_GROUP"); err != nil {
		t.Fatalf("GetConfig returned error: %v", err)
	}
	if _, err := client.HistoryList(server.URL, "", "v3", "", "app.yaml", "DEFAULT_GROUP", 1, 20); err != nil {
		t.Fatalf("HistoryList returned error: %v", err)
	}
	if _, err := client.HistoryDetail(server.URL, "", "v3", "", "app.yaml", "DEFAULT_GROUP", "42"); err != nil {
		t.Fatalf("HistoryDetail returned error: %v", err)
	}
	if err := client.DeleteConfig(server.URL, "", "v3", "", "app.yaml", "DEFAULT_GROUP"); err != nil {
		t.Fatalf("DeleteConfig returned error: %v", err)
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
