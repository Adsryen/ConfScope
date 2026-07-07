package apollo

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newApolloIPv4Server(t *testing.T, handler http.Handler) *httptest.Server {
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

func TestClientGetsNamespaceWithAuthorizationHeader(t *testing.T) {
	server := newApolloIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "apollo-token" {
			t.Fatalf("Authorization = %q, want apollo-token", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"appId":"order-service",
			"clusterName":"default",
			"namespaceName":"application",
			"format":"properties",
			"items":[
				{"key":"server.port","value":"8080","comment":"HTTP port","dataChangeLastModifiedTime":"2026-07-07T10:00:00+08:00"},
				{"key":"feature.enabled","value":"true","dataChangeLastModifiedTime":"2026-07-07T10:01:00+08:00"}
			]
		}`))
	}))

	namespace, err := NewClient().GetNamespace(server.URL, "apollo-token", "DEV", "order-service", "default", "application")
	if err != nil {
		t.Fatalf("GetNamespace returned error: %v", err)
	}
	if namespace.AppID != "order-service" || namespace.ClusterName != "default" || namespace.NamespaceName != "application" || namespace.Format != "properties" {
		t.Fatalf("unexpected namespace: %+v", namespace)
	}
	if len(namespace.Items) != 2 || namespace.Items[0].Key != "server.port" || namespace.Items[0].Value != "8080" {
		t.Fatalf("unexpected items: %+v", namespace.Items)
	}
}

func TestClientListsNamespaces(t *testing.T) {
	server := newApolloIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/openapi/v1/envs/FAT/apps/order-service/clusters/default/namespaces" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "apollo-token" {
			t.Fatalf("missing Authorization header")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[
			{"appId":"order-service","clusterName":"default","namespaceName":"application","format":"properties","items":[]},
			{"appId":"order-service","clusterName":"default","namespaceName":"datasource.json","format":"json","items":[]}
		]`))
	}))

	namespaces, err := NewClient().ListNamespaces(server.URL, "apollo-token", "FAT", "order-service", "default")
	if err != nil {
		t.Fatalf("ListNamespaces returned error: %v", err)
	}
	if len(namespaces) != 2 {
		t.Fatalf("len(namespaces) = %d, want 2", len(namespaces))
	}
	if namespaces[1].NamespaceName != "datasource.json" || namespaces[1].Format != "json" {
		t.Fatalf("unexpected namespaces: %+v", namespaces)
	}
}

func TestClientReturnsStatusErrorsWithBody(t *testing.T) {
	server := newApolloIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"token denied"}`))
	}))

	_, err := NewClient().GetNamespace(server.URL, "bad-token", "DEV", "order-service", "default", "application")
	if err == nil {
		t.Fatal("GetNamespace returned nil error")
	}
	if !strings.Contains(err.Error(), "Apollo 返回 403") || !strings.Contains(err.Error(), "token denied") {
		t.Fatalf("error = %q, want status and body", err.Error())
	}
}

func TestClientRejectsNamespaceWithoutItems(t *testing.T) {
	server := newApolloIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"appId":"order-service","clusterName":"default","namespaceName":"application"}`))
	}))

	_, err := NewClient().GetNamespace(server.URL, "apollo-token", "DEV", "order-service", "default", "application")
	if err == nil {
		t.Fatal("GetNamespace returned nil error")
	}
	if !strings.Contains(err.Error(), "items") {
		t.Fatalf("error = %q, want missing items hint", err.Error())
	}
}
