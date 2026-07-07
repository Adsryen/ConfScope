package appbackup

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestEncryptDecryptPackageRoundTrip(t *testing.T) {
	meta := PackageMeta{
		AppVersion:     "1.4.2",
		SourcePlatform: "windows",
		CreatedAt:      "2026-07-07T08:00:00.000Z",
	}
	plaintext := []byte(`{"schemaVersion":1,"data":{"connections":[{"password":"secret"}]}}`)

	packageBytes, summary, err := EncryptPackage(plaintext, "backup-password", meta)
	if err != nil {
		t.Fatalf("EncryptPackage returned error: %v", err)
	}
	if summary.SchemaVersion != PackageSchemaVersion {
		t.Fatalf("summary schema = %d, want %d", summary.SchemaVersion, PackageSchemaVersion)
	}
	if bytes.Contains(packageBytes, []byte("secret")) {
		t.Fatal("encrypted package contains plaintext secret")
	}

	decrypted, decryptedSummary, err := DecryptPackage(packageBytes, "backup-password")
	if err != nil {
		t.Fatalf("DecryptPackage returned error: %v", err)
	}
	if string(decrypted) != string(plaintext) {
		t.Fatalf("decrypted plaintext = %s, want %s", decrypted, plaintext)
	}
	if decryptedSummary.AppVersion != meta.AppVersion || decryptedSummary.SourcePlatform != meta.SourcePlatform {
		t.Fatalf("decrypted summary = %+v, want meta %+v", decryptedSummary, meta)
	}
}

func TestDecryptPackageRejectsWrongPasswordAndTampering(t *testing.T) {
	meta := PackageMeta{AppVersion: "1.4.2", SourcePlatform: "windows", CreatedAt: "2026-07-07T08:00:00.000Z"}
	packageBytes, _, err := EncryptPackage([]byte(`{"ok":true}`), "correct-password", meta)
	if err != nil {
		t.Fatalf("EncryptPackage returned error: %v", err)
	}

	if _, _, err := DecryptPackage(packageBytes, "wrong-password"); err == nil || !strings.Contains(err.Error(), "备份密码错误") {
		t.Fatalf("wrong password error = %v, want password error", err)
	}

	var envelope map[string]any
	if err := json.Unmarshal(packageBytes, &envelope); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	envelope["ciphertext"] = envelope["ciphertext"].(string)[:20] + "AAAA"
	tampered, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal tampered envelope: %v", err)
	}
	if _, _, err := DecryptPackage(tampered, "correct-password"); err == nil {
		t.Fatal("DecryptPackage accepted tampered ciphertext")
	}
}

func TestEncryptPackageRejectsEmptyPassword(t *testing.T) {
	_, _, err := EncryptPackage([]byte(`{"ok":true}`), " ", PackageMeta{
		AppVersion:     "1.4.2",
		SourcePlatform: "windows",
		CreatedAt:      "2026-07-07T08:00:00.000Z",
	})
	if err == nil || !strings.Contains(err.Error(), "备份密码不能为空") {
		t.Fatalf("error = %v, want empty password error", err)
	}
}
