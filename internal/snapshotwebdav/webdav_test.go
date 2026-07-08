package snapshotwebdav

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWebDAVClientUploadListDownloadFiltersConfigSnapshotPackages(t *testing.T) {
	files := map[string][]byte{}
	snapshot := sampleSnapshot(t)
	packageBytes, _, err := EncryptPackage(*snapshot, "snapshot-password")
	if err != nil {
		t.Fatalf("EncryptPackage returned error: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != "ops" || pass != "secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.Method {
		case "MKCOL":
			if r.URL.Path != "/confscope" && r.URL.Path != "/confscope/snapshots" {
				t.Fatalf("MKCOL path = %s, want /confscope or /confscope/snapshots", r.URL.Path)
			}
			w.WriteHeader(http.StatusCreated)
		case http.MethodPut:
			if r.URL.Path != "/confscope/snapshots/snap.cssnapshot" {
				t.Fatalf("PUT path = %s, want /confscope/snapshots/snap.cssnapshot", r.URL.Path)
			}
			body, err := io.ReadAll(r.Body)
			if err != nil {
				t.Fatalf("read body: %v", err)
			}
			files[r.URL.Path] = body
			w.WriteHeader(http.StatusCreated)
		case "PROPFIND":
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(207)
			_, _ = w.Write([]byte(`<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/confscope/snapshots/snap.cssnapshot</D:href>
    <D:propstat>
      <D:prop>
        <D:getcontentlength>11</D:getcontentlength>
        <D:getlastmodified>Wed, 08 Jul 2026 08:00:00 GMT</D:getlastmodified>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/confscope/snapshots/app.csbackup</D:href>
    <D:propstat>
      <D:prop><D:getcontentlength>99</D:getcontentlength></D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>`))
		case http.MethodGet:
			body, ok := files[r.URL.Path]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = w.Write(body)
		default:
			t.Fatalf("unexpected method %s", r.Method)
		}
	}))
	defer server.Close()

	client := NewWebDAVClient()
	target := WebDAVTarget{URL: server.URL, Username: "ops", Password: "secret", RootPath: "/confscope/snapshots"}

	remote, err := client.Upload(target, "snap.cssnapshot", packageBytes)
	if err != nil {
		t.Fatalf("Upload returned error: %v", err)
	}
	if remote.Path != "/confscope/snapshots/snap.cssnapshot" || remote.SnapshotID != snapshot.ID {
		t.Fatalf("remote = %+v, want uploaded cssnapshot summary", remote)
	}

	list, err := client.List(target)
	if err != nil {
		t.Fatalf("List returned error: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("list = %+v, want only .cssnapshot entries", list)
	}
	if list[0].Name != "snap.cssnapshot" || list[0].SnapshotID != snapshot.ID || list[0].Provider != string(snapshot.Source.Provider) {
		t.Fatalf("list[0] = %+v, want parsed snapshot package metadata", list[0])
	}

	downloaded, err := client.Download(target, "/confscope/snapshots/snap.cssnapshot")
	if err != nil {
		t.Fatalf("Download returned error: %v", err)
	}
	if string(downloaded) != string(packageBytes) {
		t.Fatal("downloaded package bytes differ from uploaded package")
	}
}

func TestWebDAVClientClassifiesHTTPFailures(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/unauthorized":
			w.WriteHeader(http.StatusUnauthorized)
		case "/forbidden":
			w.WriteHeader(http.StatusForbidden)
		case "/missing":
			w.WriteHeader(http.StatusNotFound)
		default:
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer server.Close()

	client := NewWebDAVClient()

	if err := client.Test(WebDAVTarget{URL: server.URL + "/unauthorized", RootPath: "/"}); err == nil || !strings.Contains(err.Error(), "WebDAV 认证失败") {
		t.Fatalf("unauthorized error = %v, want auth error", err)
	}
	if err := client.Test(WebDAVTarget{URL: server.URL + "/forbidden", RootPath: "/"}); err == nil || !strings.Contains(err.Error(), "WebDAV 权限不足") {
		t.Fatalf("forbidden error = %v, want forbidden error", err)
	}
	if err := client.Test(WebDAVTarget{URL: server.URL + "/missing", RootPath: "/"}); err == nil || !strings.Contains(err.Error(), "WebDAV 路径不存在") {
		t.Fatalf("missing error = %v, want missing path error", err)
	}
}

func TestWebDAVClientCreatesNestedRootCollections(t *testing.T) {
	var mkcolPaths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "MKCOL" {
			t.Fatalf("unexpected method %s", r.Method)
		}
		mkcolPaths = append(mkcolPaths, r.URL.Path)
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	client := NewWebDAVClient()

	if err := client.Test(WebDAVTarget{URL: server.URL, RootPath: "/confscope/snapshots"}); err != nil {
		t.Fatalf("Test returned error: %v", err)
	}
	want := []string{"/confscope", "/confscope/snapshots"}
	if len(mkcolPaths) != len(want) {
		t.Fatalf("MKCOL paths = %#v, want %#v", mkcolPaths, want)
	}
	for i := range want {
		if mkcolPaths[i] != want[i] {
			t.Fatalf("MKCOL paths[%d] = %q, want %q; all paths: %#v", i, mkcolPaths[i], want[i], mkcolPaths)
		}
	}
}
