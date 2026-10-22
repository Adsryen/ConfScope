package provider

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"confscope/internal/nacos"
)

func expectedProviderMSESignature(secret, namespace, group, timestamp string) string {
	if namespace == "public" {
		namespace = ""
	}
	resource := group
	if namespace != "" && group != "" {
		resource = namespace + "+" + group
	} else if namespace != "" {
		resource = namespace
	}
	signText := timestamp
	if resource != "" {
		signText = resource + "+" + timestamp
	}
	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write([]byte(signText))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func newProviderIPv4Server(t *testing.T, handler http.Handler) *httptest.Server {
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

func TestNacosProviderImplementsConfigProvider(t *testing.T) {
	var _ ConfigProvider = NewNacosProvider(nacos.NewClient())
}

func TestNacosProviderListsNamespacesAndConfigs(t *testing.T) {
	server := newProviderIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("accessToken") != "token" {
			t.Fatalf("missing accessToken header")
		}
		w.Header().Set("Content-Type", "application/json")

		switch r.URL.Path {
		case "/v3/console/core/namespace/list":
			_, _ = w.Write([]byte(`{"code":0,"data":[{"namespaceId":"ns-a","namespaceShowName":"Namespace A","configCount":7,"type":2}]}`))
		case "/v3/console/cs/config/list":
			q := r.URL.Query()
			if q.Get("namespaceId") != "ns-a" || q.Get("groupName") != "GROUP" || q.Get("dataId") != "app" {
				t.Fatalf("unexpected query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"code":0,"data":{"totalCount":1,"pageNumber":2,"pagesAvailable":3,"pageItems":[{"dataId":"app.yaml","groupName":"GROUP","content":"a: 1","type":"yaml"}]}}`))
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))

	p := NewNacosProvider(nacos.NewClient())
	profile := ConnectionProfile{
		ID:          "conn-1",
		Provider:    ProviderNacos,
		BaseURL:     server.URL,
		AccessToken: "token",
		APIVersion:  "v3",
	}

	namespaces, err := p.ListNamespaces(profile)
	if err != nil {
		t.Fatalf("ListNamespaces returned error: %v", err)
	}
	if len(namespaces) != 1 {
		t.Fatalf("len(namespaces) = %d, want 1", len(namespaces))
	}
	if namespaces[0].ID != "ns-a" || namespaces[0].Name != "Namespace A" || namespaces[0].ConfigCount != 7 {
		t.Fatalf("unexpected namespace: %+v", namespaces[0])
	}

	page, err := p.ListConfigs(profile, ListConfigsRequest{
		Namespace: "ns-a",
		Group:     "GROUP",
		DataID:    "app",
		PageNo:    2,
		PageSize:  50,
	})
	if err != nil {
		t.Fatalf("ListConfigs returned error: %v", err)
	}
	if page.TotalCount != 1 || page.PageNumber != 2 || page.PagesAvailable != 3 || len(page.PageItems) != 1 {
		t.Fatalf("unexpected page: %+v", page)
	}
	item := page.PageItems[0]
	if item.Ref.Provider != ProviderNacos || item.Ref.ConnectionID != "conn-1" || item.Ref.Namespace != "ns-a" || item.Ref.Group != "GROUP" || item.Ref.DataID != "app.yaml" {
		t.Fatalf("unexpected config ref: %+v", item.Ref)
	}
	if item.Content != "a: 1" || item.Format != "yaml" {
		t.Fatalf("unexpected config summary: %+v", item)
	}
}

func TestNacosProviderTestsConnectionWithNamespaces(t *testing.T) {
	server := newProviderIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/console/core/namespace/list" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("accessToken") != "token" {
			t.Fatalf("missing accessToken header")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"data":[]}`))
	}))

	p := NewNacosProvider(nacos.NewClient())
	err := p.TestConnection(ConnectionProfile{
		ID:          "conn-1",
		Provider:    ProviderNacos,
		BaseURL:     server.URL,
		AccessToken: "token",
		APIVersion:  "v3",
	})

	if err != nil {
		t.Fatalf("TestConnection returned error: %v", err)
	}
}

func TestNacosProviderPassesMSEAuthToClient(t *testing.T) {
	server := newProviderIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/cs/configs" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("group") != "DEFAULT_GROUP" {
			t.Fatalf("group = %q, want DEFAULT_GROUP; query: %s", r.URL.Query().Get("group"), r.URL.RawQuery)
		}
		if r.Header.Get("Spas-AccessKey") != "ak-test" {
			t.Fatalf("missing Spas-AccessKey header")
		}
		if r.Header.Get("Timestamp") == "" {
			t.Fatalf("missing Timestamp header")
		}
		wantSignature := expectedProviderMSESignature("sk-test", "public", "DEFAULT_GROUP", r.Header.Get("Timestamp"))
		if r.Header.Get("Spas-Signature") != wantSignature {
			t.Fatalf("Spas-Signature = %q, want %q", r.Header.Get("Spas-Signature"), wantSignature)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"totalCount":0,"pageNumber":1,"pagesAvailable":0,"pageItems":[]}`))
	}))

	p := NewNacosProvider(nacos.NewClient())
	_, err := p.ListConfigs(ConnectionProfile{
		ID:              "conn-mse",
		Provider:        ProviderNacos,
		BaseURL:         server.URL,
		APIVersion:      "v1",
		Distribution:    DistributionAliyunMSE,
		AuthType:        AuthAliyunAKSK,
		AccessKeyID:     "ak-test",
		AccessKeySecret: "sk-test",
	}, ListConfigsRequest{
		Namespace: "public",
		Group:     "",
		DataID:    "app",
		PageNo:    1,
		PageSize:  20,
	})
	if err != nil {
		t.Fatalf("ListConfigs returned error: %v", err)
	}
}

func TestNacosProviderTestsMSEConnectionWithConfigList(t *testing.T) {
	server := newProviderIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/cs/configs" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("tenant") != "" || r.URL.Query().Get("group") != "DEFAULT_GROUP" || r.URL.Query().Get("pageSize") != "1" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		if r.Header.Get("Spas-AccessKey") != "ak-test" {
			t.Fatalf("missing Spas-AccessKey header")
		}
		if r.Header.Get("Timestamp") == "" {
			t.Fatalf("missing Timestamp header")
		}
		wantSignature := expectedProviderMSESignature("sk-test", "", "DEFAULT_GROUP", r.Header.Get("Timestamp"))
		if r.Header.Get("Spas-Signature") != wantSignature {
			t.Fatalf("Spas-Signature = %q, want %q", r.Header.Get("Spas-Signature"), wantSignature)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"totalCount":0,"pageNumber":1,"pagesAvailable":0,"pageItems":[]}`))
	}))

	p := NewNacosProvider(nacos.NewClient())
	err := p.TestConnection(ConnectionProfile{
		ID:              "conn-mse-test",
		Provider:        ProviderNacos,
		BaseURL:         server.URL,
		APIVersion:      "v1",
		Distribution:    DistributionAliyunMSE,
		AuthType:        AuthAliyunAKSK,
		AccessKeyID:     "ak-test",
		AccessKeySecret: "sk-test",
	})
	if err != nil {
		t.Fatalf("TestConnection returned error: %v", err)
	}
}

func TestNacosProviderGetsPublishesDeletesAndReadsHistory(t *testing.T) {
	server := newProviderIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cs/configs":
			q := r.URL.Query()
			if q.Get("tenant") != "public" || q.Get("group") != "DEFAULT_GROUP" || q.Get("dataId") != "app.yaml" || q.Get("accessToken") != "token" {
				t.Fatalf("unexpected get config query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte("plain: true"))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/cs/configs":
			if r.URL.Query().Get("accessToken") != "token" {
				t.Fatalf("missing accessToken query")
			}
			if err := r.ParseForm(); err != nil {
				t.Fatalf("ParseForm: %v", err)
			}
			if r.Form.Get("tenant") != "public" || r.Form.Get("group") != "DEFAULT_GROUP" || r.Form.Get("dataId") != "app.yaml" || r.Form.Get("content") != "a: 1" || r.Form.Get("type") != "yaml" {
				t.Fatalf("unexpected publish form: %v", r.Form)
			}
			_, _ = w.Write([]byte("true"))
		case r.Method == http.MethodDelete && r.URL.Path == "/v1/cs/configs":
			q := r.URL.Query()
			if q.Get("tenant") != "public" || q.Get("group") != "DEFAULT_GROUP" || q.Get("dataId") != "app.yaml" || q.Get("accessToken") != "token" {
				t.Fatalf("unexpected delete query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte("true"))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/cs/history":
			q := r.URL.Query()
			if q.Get("nid") == "42" {
				_, _ = w.Write([]byte(`{"id":"42","dataId":"app.yaml","group":"DEFAULT_GROUP","content":"a: 1","opType":"I","createdTime":"2024-01-01","lastModifiedTime":"2024-01-02"}`))
				return
			}
			if q.Get("search") != "accurate" || q.Get("tenant") != "public" || q.Get("group") != "DEFAULT_GROUP" || q.Get("dataId") != "app.yaml" {
				t.Fatalf("unexpected history query: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"totalCount":1,"pageNumber":1,"pagesAvailable":1,"pageItems":[{"id":"42","dataId":"app.yaml","group":"DEFAULT_GROUP","opType":"I","lastModifiedTime":"2024-01-02"}]}`))
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))

	p := NewNacosProvider(nacos.NewClient())
	profile := ConnectionProfile{
		ID:          "conn-1",
		Provider:    ProviderNacos,
		BaseURL:     server.URL,
		AccessToken: "token",
		APIVersion:  "v1",
	}
	ref := ConfigRef{
		Provider:     ProviderNacos,
		ConnectionID: "conn-1",
		Namespace:    "public",
		Group:        "DEFAULT_GROUP",
		DataID:       "app.yaml",
	}

	doc, err := p.GetConfig(profile, ref)
	if err != nil {
		t.Fatalf("GetConfig returned error: %v", err)
	}
	if doc.Ref != ref || doc.Content != "plain: true" {
		t.Fatalf("unexpected document: %+v", doc)
	}

	if err := p.PublishConfig(profile, PublishConfigRequest{Ref: ref, Content: "a: 1", Format: "yaml"}); err != nil {
		t.Fatalf("PublishConfig returned error: %v", err)
	}
	if err := p.DeleteConfig(profile, ref); err != nil {
		t.Fatalf("DeleteConfig returned error: %v", err)
	}

	history, err := p.ListHistory(profile, ref, PageRequest{PageNo: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("ListHistory returned error: %v", err)
	}
	if history.TotalCount != 1 || len(history.PageItems) != 1 {
		t.Fatalf("unexpected history page: %+v", history)
	}
	if history.PageItems[0].ID != "42" || history.PageItems[0].Ref != ref {
		t.Fatalf("unexpected history item: %+v", history.PageItems[0])
	}

	detail, err := p.GetHistoryDetail(profile, ref, "42")
	if err != nil {
		t.Fatalf("GetHistoryDetail returned error: %v", err)
	}
	if detail.ID != "42" || detail.Ref != ref || !strings.Contains(detail.Content, "a: 1") {
		t.Fatalf("unexpected history detail: %+v", detail)
	}
}

// ── 轮65 WP-A：签名判定改成「凭据驱动 + 一处事实源」 ──
//
// 真机 403（2026-10-22 第 5 步执行变更）的形态是：AK/SK 填在连接里，但
// distribution/authType 两个下拉没配对 → 旧判据不签名 → 匿名请求 → 服务端把
// "accessKeyId can't be null" 原文甩到界面。判据只能有一个，四个消费点共用。

func TestNacosRequestSignRequested(t *testing.T) {
	cases := []struct {
		name    string
		profile ConnectionProfile
		want    bool
	}{
		{
			name:    "声明 MSE + AK/SK，凭据为空（轮60 的报错通路）",
			profile: ConnectionProfile{Distribution: DistributionAliyunMSE, AuthType: AuthAliyunAKSK},
			want:    true,
		},
		{
			name:    "声明 MSE + AK/SK，凭据齐全",
			profile: ConnectionProfile{Distribution: DistributionAliyunMSE, AuthType: AuthAliyunAKSK, AccessKeyID: "ak", AccessKeySecret: "sk"},
			want:    true,
		},
		{
			name:    "没标记 MSE/AK-SK，但 AK/SK 都填了（真机 403 的形态）",
			profile: ConnectionProfile{Distribution: DistributionOpenSource, AuthType: AuthNone, AccessKeyID: "ak", AccessKeySecret: "sk"},
			want:    true,
		},
		{
			name:    "只选了认证方式没选发行版，凭据齐全",
			profile: ConnectionProfile{Distribution: DistributionOpenSource, AuthType: AuthAliyunAKSK, AccessKeyID: "ak", AccessKeySecret: "sk"},
			want:    true,
		},
		{
			name:    "只填 AccessKey 没填 SecretKey：签不出来，保持匿名",
			profile: ConnectionProfile{AccessKeyID: "ak"},
			want:    false,
		},
		{
			name:    "凭据只剩空格：按没填处理",
			profile: ConnectionProfile{AccessKeyID: "  ", AccessKeySecret: "\t"},
			want:    false,
		},
		{
			name:    "开源 Nacos 账号密码连接：不签名",
			profile: ConnectionProfile{Distribution: DistributionOpenSource, AuthType: AuthNacosPassword},
			want:    false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := nacosRequestSignRequested(tc.profile); got != tc.want {
				t.Fatalf("nacosRequestSignRequested = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestNacosProviderSignsWithoutMSEMarkers(t *testing.T) {
	server := newProviderIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/cs/configs" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		q := r.URL.Query()
		// namespace/group 的归一与签名必须同一判据：public→空 tenant、空 group→DEFAULT_GROUP，
		// 签名 resource 就得是实际发出去的那个 group。
		if q.Get("tenant") != "" {
			t.Fatalf("tenant = %q, want omitted/empty; query: %s", q.Get("tenant"), r.URL.RawQuery)
		}
		if q.Get("group") != "DEFAULT_GROUP" {
			t.Fatalf("group = %q, want DEFAULT_GROUP; query: %s", q.Get("group"), r.URL.RawQuery)
		}
		if r.Header.Get("Spas-AccessKey") != "ak-test" {
			t.Fatalf("missing Spas-AccessKey header: connection has AK/SK but is not marked MSE")
		}
		if r.Header.Get("Timestamp") == "" {
			t.Fatalf("missing Timestamp header")
		}
		wantSignature := expectedProviderMSESignature("sk-test", "", "DEFAULT_GROUP", r.Header.Get("Timestamp"))
		if r.Header.Get("Spas-Signature") != wantSignature {
			t.Fatalf("Spas-Signature = %q, want %q", r.Header.Get("Spas-Signature"), wantSignature)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"totalCount":0,"pageNumber":1,"pagesAvailable":0,"pageItems":[]}`))
	}))

	p := NewNacosProvider(nacos.NewClient())
	_, err := p.ListConfigs(ConnectionProfile{
		ID:              "conn-unmarked-mse",
		Provider:        ProviderNacos,
		BaseURL:         server.URL,
		APIVersion:      "v1",
		Distribution:    DistributionOpenSource,
		AuthType:        AuthNone,
		AccessKeyID:     "ak-test",
		AccessKeySecret: "sk-test",
	}, ListConfigsRequest{
		Namespace: "public",
		Group:     "",
		DataID:    "app",
		PageNo:    1,
		PageSize:  20,
	})
	if err != nil {
		t.Fatalf("ListConfigs returned error: %v", err)
	}
}

func TestNacosProviderTestsUnmarkedMSEConnectionWithConfigList(t *testing.T) {
	var probed []string
	server := newProviderIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		probed = append(probed, r.URL.Path)
		if r.Header.Get("Spas-AccessKey") != "ak-test" {
			t.Fatalf("%s 没带 Spas-AccessKey：探活接口也必须走同一个签名判据", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"totalCount":0,"pageNumber":1,"pagesAvailable":0,"pageItems":[]}`))
	}))

	p := NewNacosProvider(nacos.NewClient())
	if err := p.TestConnection(ConnectionProfile{
		ID:              "conn-unmarked-mse",
		Provider:        ProviderNacos,
		BaseURL:         server.URL,
		APIVersion:      "v1",
		Distribution:    DistributionOpenSource,
		AuthType:        AuthNone,
		AccessKeyID:     "ak-test",
		AccessKeySecret: "sk-test",
	}); err != nil {
		t.Fatalf("TestConnection returned error: %v", err)
	}
	for _, path := range probed {
		if path == "/v1/console/namespaces" {
			t.Fatal("带 AK/SK 的连接仍在探开源命名空间接口：TestConnection 没有和签名判据共用事实源")
		}
	}
}
