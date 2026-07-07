package provider

import (
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newProviderApolloIPv4Server(t *testing.T, handler http.Handler) *httptest.Server {
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

func TestApolloProviderImplementsConfigProvider(t *testing.T) {
	var _ ConfigProvider = NewApolloProvider(nil)
}

func TestApolloProviderListsNamespacesAndConfigs(t *testing.T) {
	server := newProviderApolloIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "apollo-token" {
			t.Fatalf("missing Authorization header")
		}
		w.Header().Set("Content-Type", "application/json")

		switch r.URL.Path {
		case "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces":
			_, _ = w.Write([]byte(`[
				{"appId":"order-service","clusterName":"default","namespaceName":"application","format":"properties","items":[]},
				{"appId":"order-service","clusterName":"default","namespaceName":"datasource.json","format":"json","items":[]}
			]`))
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))

	p := NewApolloProvider(nil)
	profile := ConnectionProfile{
		ID:                  "apollo-1",
		Provider:            ProviderApollo,
		BaseURL:             server.URL,
		AccessToken:         "apollo-token",
		ApolloEnv:           "DEV",
		ApolloAppID:         "order-service",
		ApolloCluster:       "default",
		ApolloNamespaceName: "application",
	}

	namespaces, err := p.ListNamespaces(profile)
	if err != nil {
		t.Fatalf("ListNamespaces returned error: %v", err)
	}
	if len(namespaces) != 1 {
		t.Fatalf("len(namespaces) = %d, want app-level namespace", len(namespaces))
	}
	if namespaces[0].ID != "order-service" || namespaces[0].Name != "order-service / DEV / default" || namespaces[0].ConfigCount != 2 {
		t.Fatalf("unexpected namespace: %+v", namespaces[0])
	}

	page, err := p.ListConfigs(profile, ListConfigsRequest{Namespace: "order-service", PageNo: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("ListConfigs returned error: %v", err)
	}
	if page.TotalCount != 2 || len(page.PageItems) != 2 {
		t.Fatalf("unexpected page: %+v", page)
	}
	first := page.PageItems[0]
	if first.Ref.Provider != ProviderApollo || first.Ref.ConnectionID != "apollo-1" || first.Ref.Namespace != "order-service" || first.Ref.Group != "default" || first.Ref.DataID != "application" {
		t.Fatalf("unexpected ref: %+v", first.Ref)
	}
	if first.Format != "properties" {
		t.Fatalf("Format = %q, want properties", first.Format)
	}
}

func TestApolloProviderGetsConfigWithDeterministicContent(t *testing.T) {
	server := newProviderApolloIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"appId":"order-service",
			"clusterName":"default",
			"namespaceName":"application",
			"format":"properties",
			"items":[
				{"key":"z.key","value":"last","dataChangeLastModifiedTime":"2026-07-07T10:02:00+08:00"},
				{"key":"a.key","value":"first","dataChangeLastModifiedTime":"2026-07-07T10:01:00+08:00"}
			]
		}`))
	}))

	p := NewApolloProvider(nil)
	profile := ConnectionProfile{
		ID:          "apollo-1",
		Provider:    ProviderApollo,
		BaseURL:     server.URL,
		AccessToken: "apollo-token",
		ApolloEnv:   "DEV",
	}
	doc, err := p.GetConfig(profile, ConfigRef{
		Provider:  ProviderApollo,
		Namespace: "order-service",
		Group:     "default",
		DataID:    "application",
	})
	if err != nil {
		t.Fatalf("GetConfig returned error: %v", err)
	}
	if doc.Ref.Provider != ProviderApollo || doc.Ref.ConnectionID != "apollo-1" || doc.Ref.Namespace != "order-service" || doc.Ref.Group != "default" || doc.Ref.DataID != "application" {
		t.Fatalf("unexpected ref: %+v", doc.Ref)
	}
	if doc.Content != "a.key=first\nz.key=last\n" {
		t.Fatalf("Content = %q, want sorted properties", doc.Content)
	}
	if doc.Format != "properties" || doc.Source != "apollo:DEV/order-service/default/application" || doc.UpdateTime != "2026-07-07T10:02:00+08:00" {
		t.Fatalf("unexpected document metadata: %+v", doc)
	}
}

func TestApolloProviderTestsConnectionWithConfiguredNamespace(t *testing.T) {
	server := newProviderApolloIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/openapi/v1/envs/UAT/apps/order-service/clusters/default/namespaces/application" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"appId":"order-service",
			"clusterName":"default",
			"namespaceName":"application",
			"format":"properties",
			"items":[{"key":"server.port","value":"8080"}]
		}`))
	}))

	err := NewApolloProvider(nil).TestConnection(ConnectionProfile{
		ID:                  "apollo-1",
		Provider:            ProviderApollo,
		BaseURL:             server.URL,
		AccessToken:         "apollo-token",
		ApolloEnv:           "UAT",
		ApolloAppID:         "order-service",
		ApolloCluster:       "default",
		ApolloNamespaceName: "application",
	})
	if err != nil {
		t.Fatalf("TestConnection returned error: %v", err)
	}
}

func TestApolloProviderRejectsReadonlyOperations(t *testing.T) {
	p := NewApolloProvider(nil)
	profile := ConnectionProfile{ID: "apollo-1", Provider: ProviderApollo}
	ref := ConfigRef{Provider: ProviderApollo, ConnectionID: "apollo-1", Namespace: "order-service", Group: "default", DataID: "application"}

	if err := p.PublishConfig(profile, PublishConfigRequest{Ref: ref}); !errors.Is(err, errApolloReadOnly) {
		t.Fatalf("PublishConfig error = %v, want errApolloReadOnly", err)
	}
	if err := p.DeleteConfig(profile, ref); !errors.Is(err, errApolloReadOnly) {
		t.Fatalf("DeleteConfig error = %v, want errApolloReadOnly", err)
	}
	if _, err := p.ListHistory(profile, ref, PageRequest{}); !errors.Is(err, errApolloReadOnly) {
		t.Fatalf("ListHistory error = %v, want errApolloReadOnly", err)
	}
	if _, err := p.GetHistoryDetail(profile, ref, "1"); !errors.Is(err, errApolloReadOnly) {
		t.Fatalf("GetHistoryDetail error = %v, want errApolloReadOnly", err)
	}
}

func TestApolloProviderRequiresTargetNamespaceForConnectionTest(t *testing.T) {
	err := NewApolloProvider(nil).TestConnection(ConnectionProfile{
		ID:          "apollo-1",
		Provider:    ProviderApollo,
		BaseURL:     "http://apollo.example.com",
		AccessToken: "apollo-token",
		ApolloEnv:   "DEV",
		ApolloAppID: "order-service",
	})
	if err == nil {
		t.Fatal("TestConnection returned nil error")
	}
	if !strings.Contains(err.Error(), "Apollo namespaceName") {
		t.Fatalf("error = %q, want namespaceName hint", err.Error())
	}
}
