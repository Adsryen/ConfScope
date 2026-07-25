package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"confscope/internal/appbackup"
	"confscope/internal/provider"
	"confscope/internal/securestore"
	"confscope/internal/snapshotwebdav"
	"confscope/internal/updatecheck"
)

func newAppIPv4Server(t *testing.T, handler http.Handler) *httptest.Server {
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

func TestGetAppInfoReturnsVersionAndDefaultUpdateSources(t *testing.T) {
	info := NewApp().GetAppInfo()

	if info.Name != "ConfScope" {
		t.Fatalf("Name = %q, want ConfScope", info.Name)
	}
	if info.Version == "" {
		t.Fatal("Version is empty")
	}
	if len(info.UpdateSources) < 3 {
		t.Fatalf("len(UpdateSources) = %d, want at least 3", len(info.UpdateSources))
	}
}

func TestCheckForUpdatesUsesAppVersionWhenCurrentVersionIsEmpty(t *testing.T) {
	server := newAppIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"version":"9.9.9",
			"downloadUrl":"https://download.example.com/ConfScope.exe"
		}`))
	}))

	result := NewApp().CheckForUpdates(updatecheck.Request{
		Sources: []updatecheck.Source{
			{Name: "test", URL: server.URL + "/update.json"},
		},
	})

	if result.CurrentVersion == "" {
		t.Fatal("CurrentVersion is empty")
	}
	if !result.HasUpdate || result.LatestVersion != "9.9.9" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestNewAppRegistersNacosProvider(t *testing.T) {
	app := NewApp()

	p, err := app.providerFor(provider.ProviderNacos)
	if err != nil {
		t.Fatalf("providerFor returned error: %v", err)
	}
	if p == nil {
		t.Fatal("providerFor returned nil provider")
	}
	if _, ok := p.(*provider.NacosProvider); !ok {
		t.Fatalf("provider type = %T, want *provider.NacosProvider", p)
	}
}

func TestNewAppRegistersApolloProvider(t *testing.T) {
	app := NewApp()

	p, err := app.providerFor(provider.ProviderApollo)
	if err != nil {
		t.Fatalf("providerFor returned error: %v", err)
	}
	if p == nil {
		t.Fatal("providerFor returned nil provider")
	}
	if _, ok := p.(*provider.ApolloProvider); !ok {
		t.Fatalf("provider type = %T, want *provider.ApolloProvider", p)
	}
}

func TestNewAppRegistersConsulProvider(t *testing.T) {
	app := NewApp()

	p, err := app.providerFor(provider.ProviderConsul)
	if err != nil {
		t.Fatalf("providerFor returned error: %v", err)
	}
	if p == nil {
		t.Fatal("providerFor returned nil provider")
	}
	if _, ok := p.(*provider.ConsulProvider); !ok {
		t.Fatalf("provider type = %T, want *provider.ConsulProvider", p)
	}
}

type fakeConfigProvider struct {
	calls []string
}

func (f *fakeConfigProvider) record(name string) {
	f.calls = append(f.calls, name)
}

func (f *fakeConfigProvider) ListNamespaces(profile provider.ConnectionProfile) ([]provider.Namespace, error) {
	f.record("ListNamespaces:" + string(profile.Provider))
	return []provider.Namespace{{ID: "ns-a", Name: "Namespace A"}}, nil
}

func (f *fakeConfigProvider) ListConfigs(profile provider.ConnectionProfile, req provider.ListConfigsRequest) (provider.ConfigPage, error) {
	f.record("ListConfigs:" + req.Namespace)
	return provider.ConfigPage{TotalCount: 1, PageItems: []provider.ConfigSummary{{Ref: provider.ConfigRef{DataID: "app.yaml"}}}}, nil
}

func (f *fakeConfigProvider) GetConfig(profile provider.ConnectionProfile, ref provider.ConfigRef) (provider.ConfigDocument, error) {
	f.record("GetConfig:" + ref.DataID)
	return provider.ConfigDocument{Ref: ref, Content: "a: 1"}, nil
}

func (f *fakeConfigProvider) PublishConfig(profile provider.ConnectionProfile, req provider.PublishConfigRequest) error {
	f.record("PublishConfig:" + req.Ref.DataID)
	return nil
}

func (f *fakeConfigProvider) DeleteConfig(profile provider.ConnectionProfile, ref provider.ConfigRef) error {
	f.record("DeleteConfig:" + ref.DataID)
	return nil
}

func (f *fakeConfigProvider) ListHistory(profile provider.ConnectionProfile, ref provider.ConfigRef, page provider.PageRequest) (provider.HistoryPage, error) {
	f.record("ListHistory:" + ref.DataID)
	return provider.HistoryPage{TotalCount: 1, PageItems: []provider.HistoryItem{{ID: "42", Ref: ref}}}, nil
}

func (f *fakeConfigProvider) GetHistoryDetail(profile provider.ConnectionProfile, ref provider.ConfigRef, id string) (provider.HistoryDetail, error) {
	f.record("GetHistoryDetail:" + id)
	return provider.HistoryDetail{ID: id, Ref: ref, Content: "a: 1"}, nil
}

func (f *fakeConfigProvider) TestConnection(profile provider.ConnectionProfile) error {
	f.record("TestConnection:" + string(profile.Provider))
	return nil
}

func TestConfigCenterMethodsDispatchToRegisteredProvider(t *testing.T) {
	app := NewApp()
	fake := &fakeConfigProvider{}
	app.providers[provider.ProviderLocal] = fake
	profile := provider.ConnectionProfile{ID: "local-1", Provider: provider.ProviderLocal}
	ref := provider.ConfigRef{Provider: provider.ProviderLocal, ConnectionID: "local-1", DataID: "app.yaml"}

	if namespaces, err := app.ConfigCenterListNamespaces(profile); err != nil || len(namespaces) != 1 {
		t.Fatalf("ConfigCenterListNamespaces = %+v, %v", namespaces, err)
	}
	if page, err := app.ConfigCenterListConfigs(profile, provider.ListConfigsRequest{Namespace: "public"}); err != nil || page.TotalCount != 1 {
		t.Fatalf("ConfigCenterListConfigs = %+v, %v", page, err)
	}
	if doc, err := app.ConfigCenterGetConfig(profile, ref); err != nil || doc.Content != "a: 1" {
		t.Fatalf("ConfigCenterGetConfig = %+v, %v", doc, err)
	}
	if err := app.ConfigCenterPublishConfigFromApplyPlan(profile, provider.PublishConfigRequest{Ref: ref}); err != nil {
		t.Fatalf("ConfigCenterPublishConfigFromApplyPlan returned error: %v", err)
	}
	if err := app.ConfigCenterDeleteConfigFromApplyPlan(profile, ref); err != nil {
		t.Fatalf("ConfigCenterDeleteConfigFromApplyPlan returned error: %v", err)
	}
	if history, err := app.ConfigCenterListHistory(profile, ref, provider.PageRequest{PageNo: 1, PageSize: 20}); err != nil || history.TotalCount != 1 {
		t.Fatalf("ConfigCenterListHistory = %+v, %v", history, err)
	}
	if detail, err := app.ConfigCenterGetHistoryDetail(profile, ref, "42"); err != nil || detail.ID != "42" {
		t.Fatalf("ConfigCenterGetHistoryDetail = %+v, %v", detail, err)
	}
	if err := app.ConfigCenterTestConnection(profile); err != nil {
		t.Fatalf("ConfigCenterTestConnection returned error: %v", err)
	}

	want := []string{
		"ListNamespaces:local",
		"ListConfigs:public",
		"GetConfig:app.yaml",
		"PublishConfig:app.yaml",
		"DeleteConfig:app.yaml",
		"ListHistory:app.yaml",
		"GetHistoryDetail:42",
		"TestConnection:local",
	}
	if len(fake.calls) != len(want) {
		t.Fatalf("calls = %#v, want %#v", fake.calls, want)
	}
	for i := range want {
		if fake.calls[i] != want[i] {
			t.Fatalf("calls[%d] = %q, want %q; all calls: %#v", i, fake.calls[i], want[i], fake.calls)
		}
	}
}

func TestConfigCenterDirectWriteBindingsRequireApplyPlan(t *testing.T) {
	app := NewApp()
	fake := &fakeConfigProvider{}
	app.providers[provider.ProviderLocal] = fake
	profile := provider.ConnectionProfile{ID: "local-1", Provider: provider.ProviderLocal}
	ref := provider.ConfigRef{Provider: provider.ProviderLocal, ConnectionID: "local-1", DataID: "app.yaml"}

	err := app.ConfigCenterPublishConfig(profile, provider.PublishConfigRequest{Ref: ref})
	if err == nil || !strings.Contains(err.Error(), "ApplyPlan") {
		t.Fatalf("ConfigCenterPublishConfig error = %v, want ApplyPlan guard", err)
	}
	err = app.ConfigCenterDeleteConfig(profile, ref)
	if err == nil || !strings.Contains(err.Error(), "ApplyPlan") {
		t.Fatalf("ConfigCenterDeleteConfig error = %v, want ApplyPlan guard", err)
	}
	if len(fake.calls) != 0 {
		t.Fatalf("direct write bindings called provider: %#v", fake.calls)
	}
}

func TestNacosDirectWriteBindingsRequireApplyPlan(t *testing.T) {
	var calls int32
	server := newAppIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		_, _ = w.Write([]byte("true"))
	}))
	app := NewApp()

	err := app.NacosPublishConfig(server.URL, "", "v1", "public", "app.yaml", "DEFAULT_GROUP", "a: 1", "yaml")
	if err == nil || !strings.Contains(err.Error(), "ApplyPlan") {
		t.Fatalf("NacosPublishConfig error = %v, want ApplyPlan guard", err)
	}
	err = app.NacosDeleteConfig(server.URL, "", "v1", "public", "app.yaml", "DEFAULT_GROUP")
	if err == nil || !strings.Contains(err.Error(), "ApplyPlan") {
		t.Fatalf("NacosDeleteConfig error = %v, want ApplyPlan guard", err)
	}
	if got := atomic.LoadInt32(&calls); got != 0 {
		t.Fatalf("direct write bindings made %d HTTP request(s), want 0", got)
	}
}

func TestNacosApplyPlanWriteBindingsReachNacos(t *testing.T) {
	var mu sync.Mutex
	methods := []string{}
	server := newAppIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		methods = append(methods, r.Method)
		mu.Unlock()
		_, _ = w.Write([]byte("true"))
	}))
	app := NewApp()

	if err := app.NacosPublishConfigFromApplyPlan(server.URL, "", "v1", "public", "app.yaml", "DEFAULT_GROUP", "a: 1", "yaml"); err != nil {
		t.Fatalf("NacosPublishConfigFromApplyPlan returned error: %v", err)
	}
	if err := app.NacosDeleteConfigFromApplyPlan(server.URL, "", "v1", "public", "app.yaml", "DEFAULT_GROUP"); err != nil {
		t.Fatalf("NacosDeleteConfigFromApplyPlan returned error: %v", err)
	}

	want := []string{http.MethodPost, http.MethodDelete}
	mu.Lock()
	defer mu.Unlock()
	if len(methods) != len(want) {
		t.Fatalf("methods = %#v, want %#v", methods, want)
	}
	for i := range want {
		if methods[i] != want[i] {
			t.Fatalf("methods[%d] = %q, want %q; all methods: %#v", i, methods[i], want[i], methods)
		}
	}
}

func TestConfigCenterMethodsRejectUnsupportedProvider(t *testing.T) {
	app := NewApp()

	_, err := app.ConfigCenterListNamespaces(provider.ConnectionProfile{Provider: provider.ProviderType("unknown")})
	if err == nil {
		t.Fatal("ConfigCenterListNamespaces returned nil error")
	}
	if !errors.Is(err, errUnsupportedProvider) {
		t.Fatalf("error = %v, want errUnsupportedProvider", err)
	}
}

func TestValidateLocalSnapshotDirectoryAcceptsManifestAndConfigFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "confscope.snapshot.json"), []byte(`{"version":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	configDir := filepath.Join(dir, "configs")
	if err := os.Mkdir(configDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "app.yaml"), []byte("a: 1"), 0o644); err != nil {
		t.Fatal(err)
	}

	result := NewApp().ValidateLocalSnapshotDirectory(dir)

	if !result.Valid {
		t.Fatalf("Valid = false, message = %q", result.Message)
	}
	if result.Code != "legacy_valid" || !result.Legacy {
		t.Fatalf("legacy marker result = %+v, want legacy_valid", result)
	}
	if result.ConfigCount != 1 {
		t.Fatalf("ConfigCount = %d, want 1", result.ConfigCount)
	}
	if !result.HasManifest {
		t.Fatal("HasManifest = false")
	}
}

func TestValidateLocalSnapshotDirectoryAcceptsDotMetadataYaml(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".metadata.yml"), []byte("version: 1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app.yaml"), []byte("a: 1"), 0o644); err != nil {
		t.Fatal(err)
	}

	result := NewApp().ValidateLocalSnapshotDirectory(dir)

	if !result.Valid {
		t.Fatalf("Valid = false, message = %q", result.Message)
	}
	if !result.HasManifest {
		t.Fatal("HasManifest = false")
	}
	if result.ConfigCount != 1 {
		t.Fatalf("ConfigCount = %d, want 1", result.ConfigCount)
	}
}

func TestValidateLocalSnapshotDirectoryRejectsInvalidPaths(t *testing.T) {
	app := NewApp()

	if result := app.ValidateLocalSnapshotDirectory(""); result.Valid || result.Message == "" || result.Code != "empty_path" {
		t.Fatalf("empty path result = %+v", result)
	}

	file := filepath.Join(t.TempDir(), "app.yaml")
	if err := os.WriteFile(file, []byte("a: 1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if result := app.ValidateLocalSnapshotDirectory(file); result.Valid || result.Message != "路径不是文件夹" || result.Code != "not_directory" {
		t.Fatalf("file path result = %+v", result)
	}

	emptyDir := t.TempDir()
	if result := app.ValidateLocalSnapshotDirectory(emptyDir); result.Valid || result.Message != "未找到快照清单或标准目录结构" || result.Code != "missing_structure" {
		t.Fatalf("empty dir result = %+v", result)
	}
}

func TestAppDataBackupLocalBindingsEncryptAndReadBack(t *testing.T) {
	app := NewApp()
	path := filepath.Join(t.TempDir(), "app.csbackup")
	meta := appbackup.PackageMeta{
		AppVersion:     "1.4.2",
		SourcePlatform: "windows",
		CreatedAt:      "2026-07-07T08:00:00.000Z",
	}
	plaintext := `{"schemaVersion":1,"data":{"connections":[{"password":"secret"}]}}`

	summary, err := app.WriteAppDataBackupFile(path, plaintext, "backup-password", meta)
	if err != nil {
		t.Fatalf("WriteAppDataBackupFile returned error: %v", err)
	}
	if summary.SchemaVersion != appbackup.PackageSchemaVersion {
		t.Fatalf("summary schema = %d, want %d", summary.SchemaVersion, appbackup.PackageSchemaVersion)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read backup file: %v", err)
	}
	if strings.Contains(string(raw), "secret") {
		t.Fatal("backup file contains plaintext secret")
	}

	decrypted, err := app.ReadAppDataBackupFile(path, "backup-password")
	if err != nil {
		t.Fatalf("ReadAppDataBackupFile returned error: %v", err)
	}
	if decrypted.PlaintextJSON != plaintext {
		t.Fatalf("PlaintextJSON = %s, want %s", decrypted.PlaintextJSON, plaintext)
	}

	if _, err := app.CreateAppDataRecoveryPoint(plaintext, "backup-password", meta); err != nil {
		t.Fatalf("CreateAppDataRecoveryPoint returned error: %v", err)
	}
	recoveryDir, err := appDataRecoveryPointStorageDir()
	if err != nil {
		t.Fatalf("appDataRecoveryPointStorageDir returned error: %v", err)
	}
	if _, err := os.Stat(filepath.Join(recoveryDir, appbackup.DefaultBackupFileName(meta))); err != nil {
		t.Fatalf("recovery point should be written under portable data dir: %v", err)
	}
}

func TestAppDataSnapshotFilesBindingsListAndRestore(t *testing.T) {
	app := NewApp()
	created, err := app.CreateSnapshot(provider.SnapshotSource{
		Provider:       provider.ProviderNacos,
		ConnectionID:   "conn-backup",
		ConnectionName: "backup-nacos",
		Namespace:      "public",
		NamespaceID:    "public",
	}, []provider.ConfigSnapshot{
		{DataID: "app.yaml", Group: "DEFAULT_GROUP", Content: "name: demo\n", ConfigType: "yaml", ContentType: "yaml"},
	})
	if err != nil {
		t.Fatalf("CreateSnapshot returned error: %v", err)
	}

	files, err := app.ListAppDataSnapshotFiles()
	if err != nil {
		t.Fatalf("ListAppDataSnapshotFiles returned error: %v", err)
	}
	foundMetadata := false
	for _, file := range files {
		if file.Path == filepath.ToSlash(filepath.Join(created.ID, "metadata.json")) && file.ContentBase64 != "" {
			foundMetadata = true
			break
		}
	}
	if !foundMetadata {
		t.Fatalf("snapshot metadata for %s not found in backup files: %+v", created.ID, files)
	}

	if err := app.RestoreAppDataSnapshotFiles([]AppDataSnapshotFile{{
		Path:          filepath.ToSlash(filepath.Join("restore_test", "metadata.json")),
		ContentBase64: "eyJpZCI6InJlc3RvcmVfdGVzdCJ9",
		Mode:          0o644,
	}}); err != nil {
		t.Fatalf("RestoreAppDataSnapshotFiles returned error: %v", err)
	}
	snapshotDir, err := snapshotStorageDir()
	if err != nil {
		t.Fatalf("snapshotStorageDir returned error: %v", err)
	}
	restored, err := os.ReadFile(filepath.Join(snapshotDir, "restore_test", "metadata.json"))
	if err != nil {
		t.Fatalf("ReadFile restored snapshot file: %v", err)
	}
	if string(restored) != `{"id":"restore_test"}` {
		t.Fatalf("restored snapshot file = %q", string(restored))
	}
	if err := app.RestoreAppDataSnapshotFiles([]AppDataSnapshotFile{{Path: "../outside.json", ContentBase64: "e30="}}); err == nil {
		t.Fatal("RestoreAppDataSnapshotFiles returned nil error for unsafe path")
	}
}

func TestRunCredentialStorePoCRejectsInvalidRunID(t *testing.T) {
	_, err := NewApp().RunCredentialStorePoC("bad/run")
	if !errors.Is(err, securestore.ErrInvalidSecretRef) {
		t.Fatalf("RunCredentialStorePoC error = %v, want ErrInvalidSecretRef", err)
	}
}

func TestRunCredentialStorePoCRoundTrip(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows Credential Manager PoC is Windows-only")
	}

	runID := "app-test-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	result, err := NewApp().RunCredentialStorePoC(runID)
	if err != nil {
		t.Fatalf("RunCredentialStorePoC returned error: %v", err)
	}
	if !result.OK || !result.ReadBackOK || !result.Deleted {
		t.Fatalf("result = %+v, want ok/readBack/deleted", result)
	}
	if got, want := result.TargetName, "ConfScope/poc/"+runID; got != want {
		t.Fatalf("TargetName = %q, want %q", got, want)
	}
	if strings.Contains(fmt.Sprintf("%+v", result), "secret-") {
		t.Fatalf("result leaks secret material: %+v", result)
	}
}

func TestRunCredentialStorePoCReportsReadBackMismatch(t *testing.T) {
	store := &credentialPoCFakeStore{getValue: []byte("different-secret")}

	result, err := runCredentialStorePoC(context.Background(), store, "mismatch-test")

	if !errors.Is(err, securestore.ErrSecretVerifyFailed) {
		t.Fatalf("runCredentialStorePoC error = %v, want ErrSecretVerifyFailed", err)
	}
	if result.OK || result.ReadBackOK || result.Deleted {
		t.Fatalf("result = %+v, want failed verification without success flags", result)
	}
	if store.deleteCount == 0 {
		t.Fatal("runCredentialStorePoC did not clean up after read-back mismatch")
	}
	if strings.Contains(fmt.Sprintf("%+v", result), "different-secret") {
		t.Fatalf("result leaks fake secret material: %+v", result)
	}
}

type credentialPoCFakeStore struct {
	getValue    []byte
	deleteCount int
}

func (s *credentialPoCFakeStore) Put(context.Context, securestore.SecretRef, []byte) error {
	return nil
}

func (s *credentialPoCFakeStore) Get(context.Context, securestore.SecretRef) ([]byte, error) {
	return append([]byte(nil), s.getValue...), nil
}

func (s *credentialPoCFakeStore) Delete(context.Context, securestore.SecretRef) error {
	s.deleteCount++
	return nil
}

func TestSnapshotWebDAVBindingsUploadListAndImport(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	files := map[string][]byte{}
	server := newAppIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case "MKCOL":
			if r.URL.Path != "/confscope" && r.URL.Path != "/confscope/snapshots" {
				t.Fatalf("MKCOL path = %s, want /confscope or /confscope/snapshots", r.URL.Path)
			}
			w.WriteHeader(http.StatusCreated)
		case http.MethodPut:
			body, err := io.ReadAll(r.Body)
			if err != nil {
				t.Fatalf("read upload body: %v", err)
			}
			files[r.URL.Path] = body
			w.WriteHeader(http.StatusCreated)
		case "PROPFIND":
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(207)
			_, _ = w.Write([]byte(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">`))
			for remotePath, body := range files {
				_, _ = w.Write([]byte(`<d:response><d:href>` + remotePath + `</d:href><d:propstat><d:prop><d:getcontentlength>` + strconv.Itoa(len(body)) + `</d:getcontentlength></d:prop></d:propstat></d:response>`))
			}
			_, _ = w.Write([]byte(`<d:response><d:href>/confscope/snapshots/app.csbackup</d:href><d:propstat><d:prop><d:getcontentlength>5</d:getcontentlength></d:prop></d:propstat></d:response></d:multistatus>`))
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

	app := NewApp()
	created, err := app.CreateSnapshot(provider.SnapshotSource{
		Provider:       provider.ProviderNacos,
		ConnectionID:   "conn-dev",
		ConnectionName: "dev-nacos",
		Namespace:      "public",
		NamespaceID:    "public",
	}, []provider.ConfigSnapshot{
		{DataID: "app.yaml", Group: "DEFAULT_GROUP", Content: "password: super-secret\n", ConfigType: "yaml", ContentType: "yaml"},
	})
	if err != nil {
		t.Fatalf("CreateSnapshot returned error: %v", err)
	}

	target := snapshotwebdav.WebDAVTarget{URL: server.URL, RootPath: "/confscope/snapshots"}
	remote, err := app.UploadSnapshotWebDAVPackage(target, created.ID, "snapshot-password")
	if err != nil {
		t.Fatalf("UploadSnapshotWebDAVPackage returned error: %v", err)
	}
	if remote.SnapshotID != created.ID || !strings.HasSuffix(remote.Name, ".cssnapshot") {
		t.Fatalf("remote = %+v, want uploaded config snapshot package", remote)
	}

	list, err := app.ListSnapshotWebDAVPackages(target)
	if err != nil {
		t.Fatalf("ListSnapshotWebDAVPackages returned error: %v", err)
	}
	if len(list) != 1 || list[0].SnapshotID != created.ID {
		t.Fatalf("list = %+v, want only uploaded .cssnapshot", list)
	}

	imported, err := app.ImportSnapshotWebDAVPackage(target, remote.Path, "snapshot-password")
	if err != nil {
		t.Fatalf("ImportSnapshotWebDAVPackage returned error: %v", err)
	}
	if imported.ID == created.ID || imported.RemoteSnapshotID != created.ID {
		t.Fatalf("imported = %+v, want non-overwriting import with remoteSnapshotId", imported)
	}

	doc, err := provider.NewLocalProvider().GetConfig(provider.ConnectionProfile{ID: "snapshot-local", Provider: provider.ProviderLocal, BaseURL: imported.Path}, provider.ConfigRef{
		Provider: provider.ProviderLocal,
		Group:    "DEFAULT_GROUP",
		DataID:   "app.yaml",
	})
	if err != nil {
		t.Fatalf("local provider GetConfig returned error: %v", err)
	}
	if doc.Content != "password: super-secret\n" {
		t.Fatalf("imported content = %q, want original config content", doc.Content)
	}
}
