package provider

import (
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newProviderConsulIPv4Server(t *testing.T, handler http.Handler) *httptest.Server {
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

func TestConsulProviderImplementsConfigProvider(t *testing.T) {
	var _ ConfigProvider = NewConsulProvider(nil)
}

func TestConsulProviderListsNamespacesAndConfigs(t *testing.T) {
	server := newProviderConsulIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Consul-Token") != "consul-token" {
			t.Fatalf("missing X-Consul-Token header")
		}
		w.Header().Set("Content-Type", "application/json")

		switch r.URL.Path {
		case "/v1/catalog/datacenters":
			_, _ = w.Write([]byte(`["dc1","dc2"]`))
		case "/v1/kv/apps/order/":
			if r.URL.Query().Get("dc") != "dc1" || r.URL.Query().Get("recurse") != "true" {
				t.Fatalf("query = %s, want dc=dc1&recurse=true", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`[
				{"Key":"apps/order/","Value":null,"CreateIndex":1,"ModifyIndex":2},
				{"Key":"apps/order/app.yaml","Value":"c2VydmVyOgogIHBvcnQ6IDgwODAK","CreateIndex":10,"ModifyIndex":42},
				{"Key":"apps/order/feature.json","Value":"eyJlbmFibGVkIjp0cnVlfQ==","CreateIndex":11,"ModifyIndex":43}
			]`))
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))

	p := NewConsulProvider(nil)
	profile := ConnectionProfile{
		ID:               "consul-1",
		Provider:         ProviderConsul,
		BaseURL:          server.URL,
		AccessToken:      "consul-token",
		ConsulDatacenter: "dc1",
		ConsulKeyPrefix:  "apps/order/",
	}

	namespaces, err := p.ListNamespaces(profile)
	if err != nil {
		t.Fatalf("ListNamespaces returned error: %v", err)
	}
	if len(namespaces) != 2 || namespaces[0].ID != "dc1" || namespaces[0].Name != "dc1" {
		t.Fatalf("unexpected namespaces: %+v", namespaces)
	}

	page, err := p.ListConfigs(profile, ListConfigsRequest{Namespace: "dc1", Group: "apps/order/", PageNo: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("ListConfigs returned error: %v", err)
	}
	if page.TotalCount != 2 || len(page.PageItems) != 2 {
		t.Fatalf("unexpected page: %+v", page)
	}
	first := page.PageItems[0]
	if first.Ref.Provider != ProviderConsul || first.Ref.ConnectionID != "consul-1" || first.Ref.Namespace != "dc1" || first.Ref.Group != "apps/order/" || first.Ref.DataID != "apps/order/app.yaml" {
		t.Fatalf("unexpected ref: %+v", first.Ref)
	}
	if first.Content != "server:\n  port: 8080\n" || first.Format != "yaml" || first.UpdateTime != "42" {
		t.Fatalf("unexpected first item: %+v", first)
	}
}

func TestConsulProviderGetsConfigWithFullKeyRef(t *testing.T) {
	server := newProviderConsulIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/kv/apps/order/app.yaml" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("dc") != "dc1" {
			t.Fatalf("query = %s, want dc=dc1", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"Key":"apps/order/app.yaml","Value":"c2VydmVyOgogIHBvcnQ6IDgwODAK","CreateIndex":10,"ModifyIndex":42}]`))
	}))

	doc, err := NewConsulProvider(nil).GetConfig(
		ConnectionProfile{ID: "consul-1", Provider: ProviderConsul, BaseURL: server.URL, AccessToken: "consul-token", ConsulDatacenter: "dc1", ConsulKeyPrefix: "apps/order/"},
		ConfigRef{Provider: ProviderConsul, Namespace: "dc1", Group: "apps/order/", DataID: "apps/order/app.yaml"},
	)
	if err != nil {
		t.Fatalf("GetConfig returned error: %v", err)
	}
	if doc.Ref.Provider != ProviderConsul || doc.Ref.ConnectionID != "consul-1" || doc.Ref.Namespace != "dc1" || doc.Ref.Group != "apps/order/" || doc.Ref.DataID != "apps/order/app.yaml" {
		t.Fatalf("unexpected ref: %+v", doc.Ref)
	}
	if doc.Content != "server:\n  port: 8080\n" || doc.Format != "yaml" || doc.Version != "42" || doc.Source != "consul:dc1/apps/order/app.yaml" {
		t.Fatalf("unexpected document: %+v", doc)
	}
}

func TestConsulProviderMapsDefaultGroupToConfiguredPrefix(t *testing.T) {
	server := newProviderConsulIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/kv/apps/order/":
			_, _ = w.Write([]byte(`[{"Key":"apps/order/app.yaml","Value":"c2VydmVyOiA4MDgwCg==","ModifyIndex":42}]`))
		case "/v1/kv/apps/order/app.yaml":
			_, _ = w.Write([]byte(`[{"Key":"apps/order/app.yaml","Value":"c2VydmVyOiA4MDgwCg==","ModifyIndex":42}]`))
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	p := NewConsulProvider(nil)
	profile := ConnectionProfile{
		ID:               "consul-1",
		Provider:         ProviderConsul,
		BaseURL:          server.URL,
		ConsulDatacenter: "dc1",
		ConsulKeyPrefix:  "apps/order/",
	}

	page, err := p.ListConfigs(profile, ListConfigsRequest{Namespace: "dc1", Group: "DEFAULT_GROUP", PageNo: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("ListConfigs returned error: %v", err)
	}
	if len(page.PageItems) != 1 || page.PageItems[0].Ref.Group != "apps/order/" {
		t.Fatalf("unexpected page items: %+v", page.PageItems)
	}

	doc, err := p.GetConfig(profile, ConfigRef{Provider: ProviderConsul, Namespace: "dc1", Group: "DEFAULT_GROUP", DataID: "apps/order/app.yaml"})
	if err != nil {
		t.Fatalf("GetConfig returned error: %v", err)
	}
	if doc.Ref.Group != "apps/order/" {
		t.Fatalf("doc ref group = %q, want configured prefix", doc.Ref.Group)
	}
}

func TestConsulProviderTestsConnectionWithConfiguredPrefix(t *testing.T) {
	server := newProviderConsulIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/kv/apps/order/" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("dc") != "dc1" || r.URL.Query().Get("recurse") != "true" {
			t.Fatalf("query = %s, want dc=dc1&recurse=true", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"Key":"apps/order/app.yaml","Value":"c2VydmVyOiA4MDgwCg==","ModifyIndex":42}]`))
	}))

	err := NewConsulProvider(nil).TestConnection(ConnectionProfile{
		ID:               "consul-1",
		Provider:         ProviderConsul,
		BaseURL:          server.URL,
		AccessToken:      "consul-token",
		ConsulDatacenter: "dc1",
		ConsulKeyPrefix:  "apps/order/",
	})
	if err != nil {
		t.Fatalf("TestConnection returned error: %v", err)
	}
}

func TestConsulProviderRejectsReadonlyOperations(t *testing.T) {
	p := NewConsulProvider(nil)
	profile := ConnectionProfile{ID: "consul-1", Provider: ProviderConsul}
	ref := ConfigRef{Provider: ProviderConsul, ConnectionID: "consul-1", Namespace: "dc1", Group: "apps/order/", DataID: "apps/order/app.yaml"}

	if _, err := p.ListHistory(profile, ref, PageRequest{}); !errors.Is(err, errConsulReadOnly) {
		t.Fatalf("ListHistory error = %v, want errConsulReadOnly", err)
	}
	if _, err := p.GetHistoryDetail(profile, ref, "1"); !errors.Is(err, errConsulReadOnly) {
		t.Fatalf("GetHistoryDetail error = %v, want errConsulReadOnly", err)
	}
}

func TestConsulProviderRequiresKeyForGetConfig(t *testing.T) {
	_, err := NewConsulProvider(nil).GetConfig(ConnectionProfile{ID: "consul-1", Provider: ProviderConsul, BaseURL: "http://consul.example.com"}, ConfigRef{})
	if err == nil {
		t.Fatal("GetConfig returned nil error")
	}
	if !strings.Contains(err.Error(), "Consul key") {
		t.Fatalf("error = %q, want key hint", err.Error())
	}
}

func TestConsulProviderPublishesKVWithExpectedVersion(t *testing.T) {
	server := newProviderConsulIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Fatalf("method = %s, want PUT", r.Method)
		}
		if r.URL.Path != "/v1/kv/apps/order/app.yaml" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("dc") != "dc1" || r.URL.Query().Get("cas") != "42" {
			t.Fatalf("query = %s, want dc=dc1&cas=42", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`true`))
	}))

	err := NewConsulProvider(nil).PublishConfig(
		ConnectionProfile{ID: "consul-1", Provider: ProviderConsul, BaseURL: server.URL, AccessToken: "consul-token", ConsulDatacenter: "dc1", ConsulKeyPrefix: "apps/order/"},
		PublishConfigRequest{
			Ref:     ConfigRef{Provider: ProviderConsul, Namespace: "dc1", Group: "apps/order/", DataID: "apps/order/app.yaml", ExpectedVersion: "42"},
			Content: "server:\n  port: 9090\n",
			Format:  "yaml",
		},
	)
	if err != nil {
		t.Fatalf("PublishConfig returned error: %v", err)
	}
}

func TestConsulProviderCreatesKVWithExpectedVersionZero(t *testing.T) {
	server := newProviderConsulIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("cas") != "0" {
			t.Fatalf("query = %s, want cas=0", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`true`))
	}))

	err := NewConsulProvider(nil).PublishConfig(
		ConnectionProfile{ID: "consul-1", Provider: ProviderConsul, BaseURL: server.URL, ConsulDatacenter: "dc1", ConsulKeyPrefix: "apps/order/"},
		PublishConfigRequest{
			Ref:     ConfigRef{Provider: ProviderConsul, Namespace: "dc1", Group: "apps/order/", DataID: "apps/order/new.yaml", ExpectedVersion: "0"},
			Content: "created: true\n",
			Format:  "yaml",
		},
	)
	if err != nil {
		t.Fatalf("PublishConfig returned error: %v", err)
	}
}

func TestConsulProviderDeletesKVWithExpectedVersion(t *testing.T) {
	server := newProviderConsulIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Fatalf("method = %s, want DELETE", r.Method)
		}
		if r.URL.Path != "/v1/kv/apps/order/app.yaml" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("dc") != "dc1" || r.URL.Query().Get("cas") != "42" {
			t.Fatalf("query = %s, want dc=dc1&cas=42", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`true`))
	}))

	err := NewConsulProvider(nil).DeleteConfig(
		ConnectionProfile{ID: "consul-1", Provider: ProviderConsul, BaseURL: server.URL, ConsulDatacenter: "dc1", ConsulKeyPrefix: "apps/order/"},
		ConfigRef{Provider: ProviderConsul, Namespace: "dc1", Group: "apps/order/", DataID: "apps/order/app.yaml", ExpectedVersion: "42"},
	)
	if err != nil {
		t.Fatalf("DeleteConfig returned error: %v", err)
	}
}

func TestConsulProviderRequiresExpectedVersionForWrites(t *testing.T) {
	p := NewConsulProvider(nil)
	profile := ConnectionProfile{ID: "consul-1", Provider: ProviderConsul, BaseURL: "http://consul.example.com"}
	ref := ConfigRef{Provider: ProviderConsul, Namespace: "dc1", Group: "apps/order/", DataID: "apps/order/app.yaml"}

	if err := p.PublishConfig(profile, PublishConfigRequest{Ref: ref, Content: "server: 9090\n", Format: "yaml"}); err == nil || !strings.Contains(err.Error(), "expectedVersion") {
		t.Fatalf("PublishConfig error = %v, want expectedVersion error", err)
	}
	if err := p.DeleteConfig(profile, ref); err == nil || !strings.Contains(err.Error(), "expectedVersion") {
		t.Fatalf("DeleteConfig error = %v, want expectedVersion error", err)
	}
}

func TestConsulProviderRejectsInvalidUTF8Content(t *testing.T) {
	err := NewConsulProvider(nil).PublishConfig(
		ConnectionProfile{ID: "consul-1", Provider: ProviderConsul, BaseURL: "http://consul.example.com"},
		PublishConfigRequest{
			Ref:     ConfigRef{Provider: ProviderConsul, Namespace: "dc1", Group: "apps/order/", DataID: "apps/order/app.yaml", ExpectedVersion: "42"},
			Content: string([]byte{0xff, 0xfe}),
			Format:  "text",
		},
	)
	if err == nil || !strings.Contains(err.Error(), "UTF-8") {
		t.Fatalf("PublishConfig error = %v, want UTF-8 error", err)
	}
}
