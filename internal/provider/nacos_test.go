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
	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write([]byte(namespace + "+" + group + "+" + timestamp))
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
		Group:     "DEFAULT_GROUP",
		DataID:    "app",
		PageNo:    1,
		PageSize:  20,
	})
	if err != nil {
		t.Fatalf("ListConfigs returned error: %v", err)
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
