//go:build linux

package securestore

import (
	"bytes"
	"context"
	"errors"
	"os"
	"testing"
)

// 本地（无 D-Bus 会话总线）构造大凭据库必须如实报「不支持」，而不是静默降级。
func TestNewLargeStoreUnavailableWithoutSecretService(t *testing.T) {
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/nonexistent/confscope-r105-bus")

	_, err := NewLargeStore(t.TempDir())
	if !errors.Is(err, ErrSecretServiceUnavailable) {
		t.Fatalf("NewLargeStore error = %v, want ErrSecretServiceUnavailable", err)
	}
}

// 小凭据库在无服务时同样必须如实报「不支持」。
func TestCredentialManagerStoreUnavailableWithoutSecretService(t *testing.T) {
	t.Setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/nonexistent/confscope-r105-bus")

	store := NewCredentialManagerStore()
	ref, err := NewSecretRef("confscope-probe", "owner-1", "password")
	if err != nil {
		t.Fatalf("NewSecretRef returned error: %v", err)
	}
	if err := store.Put(context.Background(), ref, []byte("probe")); !errors.Is(err, ErrSecretServiceUnavailable) {
		t.Fatalf("Put error = %v, want ErrSecretServiceUnavailable", err)
	}
	if _, err := store.Get(context.Background(), ref); !errors.Is(err, ErrSecretServiceUnavailable) {
		t.Fatalf("Get error = %v, want ErrSecretServiceUnavailable", err)
	}
	if err := store.Delete(context.Background(), ref); !errors.Is(err, ErrSecretServiceUnavailable) {
		t.Fatalf("Delete error = %v, want ErrSecretServiceUnavailable", err)
	}
}

func assertDataDirHasNoFiles(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read data dir: %v", err)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("data dir %s contains files %v; secret service 路径不得把任何凭据材料写进数据目录", dir, names)
	}
}

// TestSecretServiceRoundTrip 在真实 Secret Service（容器内 dbus-run-session +
// gnome-keyring）上验证大凭据 Put → Get → 覆盖 → Delete 全链路；
// 普通开发环境没有会话总线时自动跳过。
func TestSecretServiceRoundTrip(t *testing.T) {
	if os.Getenv("DBUS_SESSION_BUS_ADDRESS") == "" {
		t.Skip("no D-Bus session bus, skipping real secret service roundtrip")
	}
	ctx := context.Background()
	dataDir := t.TempDir()
	store, err := NewLargeStore(dataDir)
	if err != nil {
		t.Skipf("no usable secret service, skipping roundtrip: %v", err)
	}

	ref, err := NewLargeRef("connection-ssh", "roundtrip", "privateKey")
	if err != nil {
		t.Fatalf("NewLargeRef returned error: %v", err)
	}
	value := "-----BEGIN OPENSSH PRIVATE KEY-----\nconfscope-r105-roundtrip-key-material\n-----END OPENSSH PRIVATE KEY-----\n"

	if err := store.PutLarge(ctx, ref, []byte(value)); err != nil {
		t.Fatalf("PutLarge returned error: %v", err)
	}
	got, err := store.GetLarge(ctx, ref)
	if err != nil {
		t.Fatalf("GetLarge returned error: %v", err)
	}
	if !bytes.Equal(got, []byte(value)) {
		t.Fatalf("GetLarge value mismatch (len got=%d want=%d)", len(got), len(value))
	}

	// 第二个独立实例 = 新 D-Bus 连接 + 新会话，验证跨会话读回（服务侧负责换会话重加密）。
	store2, err := NewLargeStore(dataDir)
	if err != nil {
		t.Fatalf("second NewLargeStore returned error: %v", err)
	}
	got2, err := store2.GetLarge(ctx, ref)
	if err != nil {
		t.Fatalf("cross-session GetLarge returned error: %v", err)
	}
	if !bytes.Equal(got2, []byte(value)) {
		t.Fatalf("cross-session GetLarge value mismatch")
	}

	// 覆盖写：replace 语义，读回必须拿到新值。
	second := []byte("second-value-after-replace")
	if err := store2.PutLarge(ctx, ref, second); err != nil {
		t.Fatalf("second PutLarge returned error: %v", err)
	}
	got3, err := store2.GetLarge(ctx, ref)
	if err != nil {
		t.Fatalf("GetLarge after replace returned error: %v", err)
	}
	if !bytes.Equal(got3, second) {
		t.Fatalf("GetLarge after replace value mismatch")
	}

	// Delete 后 Get 必须报 not found，Delete 幂等。
	if err := store2.DeleteLarge(ctx, ref); err != nil {
		t.Fatalf("DeleteLarge returned error: %v", err)
	}
	if _, err := store2.GetLarge(ctx, ref); !errors.Is(err, ErrSecretNotFound) {
		t.Fatalf("GetLarge after delete error = %v, want ErrSecretNotFound", err)
	}
	if err := store2.DeleteLarge(ctx, ref); err != nil {
		t.Fatalf("second DeleteLarge (idempotency) returned error: %v", err)
	}

	// 这条线存在的理由：明文绝不落数据目录。
	assertDataDirHasNoFiles(t, dataDir)
}

// TestSecretServiceSmallRoundTrip 验证小凭据库在同一真实服务上同样可用
// （Linux 上小凭据不再是不支持，而是走同一个 secret service）。
func TestSecretServiceSmallRoundTrip(t *testing.T) {
	if os.Getenv("DBUS_SESSION_BUS_ADDRESS") == "" {
		t.Skip("no D-Bus session bus, skipping real secret service roundtrip")
	}
	ctx := context.Background()
	store := NewCredentialManagerStore()
	ref, err := NewSecretRef("confscope-roundtrip", "owner-1", "password")
	if err != nil {
		t.Fatalf("NewSecretRef returned error: %v", err)
	}

	value := []byte("hunter2")
	if err := store.Put(ctx, ref, value); err != nil {
		t.Fatalf("Put returned error: %v", err)
	}
	got, err := store.Get(ctx, ref)
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
	if !bytes.Equal(got, value) {
		t.Fatalf("Get value = %q, want %q", got, value)
	}
	if err := store.Delete(ctx, ref); err != nil {
		t.Fatalf("Delete returned error: %v", err)
	}
	if _, err := store.Get(ctx, ref); !errors.Is(err, ErrSecretNotFound) {
		t.Fatalf("Get after delete error = %v, want ErrSecretNotFound", err)
	}
}
