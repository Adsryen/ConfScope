package appbackup

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWebDAVClientUploadListDownload(t *testing.T) {
	files := map[string][]byte{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != "ops" || pass != "secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.Method {
		case "MKCOL":
			if r.URL.Path != "/confscope" {
				t.Fatalf("MKCOL path = %s, want /confscope", r.URL.Path)
			}
			w.WriteHeader(http.StatusCreated)
		case http.MethodPut:
			if r.URL.Path != "/confscope/app.csbackup" {
				t.Fatalf("PUT path = %s, want /confscope/app.csbackup", r.URL.Path)
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
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/confscope/app.csbackup</d:href>
    <d:propstat>
      <d:prop>
        <d:getcontentlength>11</d:getcontentlength>
        <d:getlastmodified>Tue, 07 Jul 2026 08:00:00 GMT</d:getlastmodified>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`))
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
	target := WebDAVTarget{URL: server.URL, Username: "ops", Password: "secret", RootPath: "/confscope"}

	remote, err := client.Upload(target, "app.csbackup", []byte("hello backup"))
	if err != nil {
		t.Fatalf("Upload returned error: %v", err)
	}
	if remote.Path != "/confscope/app.csbackup" {
		t.Fatalf("remote path = %s, want /confscope/app.csbackup", remote.Path)
	}

	list, err := client.List(target)
	if err != nil {
		t.Fatalf("List returned error: %v", err)
	}
	if len(list) != 1 || list[0].Name != "app.csbackup" || list[0].Size != 11 {
		t.Fatalf("list = %+v, want one app.csbackup", list)
	}

	downloaded, err := client.Download(target, "/confscope/app.csbackup")
	if err != nil {
		t.Fatalf("Download returned error: %v", err)
	}
	if string(downloaded) != "hello backup" {
		t.Fatalf("downloaded = %s, want hello backup", downloaded)
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
