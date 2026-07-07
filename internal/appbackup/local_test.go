package appbackup

import (
	"strings"
	"testing"
)

func TestWriteAndReadLocalBackup(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/nested/app-data.csbackup"
	content := []byte(`{"format":"confscope.app-data-backup"}`)

	if err := WriteLocalBackup(path, content); err != nil {
		t.Fatalf("WriteLocalBackup returned error: %v", err)
	}
	got, err := ReadLocalBackup(path)
	if err != nil {
		t.Fatalf("ReadLocalBackup returned error: %v", err)
	}
	if string(got) != string(content) {
		t.Fatalf("content = %s, want %s", got, content)
	}
}

func TestLocalBackupRejectsEmptyPath(t *testing.T) {
	if err := WriteLocalBackup(" ", []byte("x")); err == nil || !strings.Contains(err.Error(), "备份文件路径不能为空") {
		t.Fatalf("WriteLocalBackup error = %v, want empty path error", err)
	}
	if _, err := ReadLocalBackup(" "); err == nil || !strings.Contains(err.Error(), "备份文件路径不能为空") {
		t.Fatalf("ReadLocalBackup error = %v, want empty path error", err)
	}
}
