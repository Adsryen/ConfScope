package audit

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAppendAndReadLines(t *testing.T) {
	dir := t.TempDir()
	payloads := []string{
		`{"schema":1,"ts":"t0","kind":"session_start","sessionId":"a"}`,
		`{"schema":1,"ts":"t1","kind":"compare_start","sessionId":"a"}`,
		`{"schema":1,"ts":"t2","kind":"compare_result","sessionId":"a","result":"success"}`,
	}
	for i, line := range payloads {
		if err := Append(dir, line); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}
	lines := ReadLines(dir, 0)
	if len(lines) != 3 {
		t.Fatalf("want 3 lines, got %d: %v", len(lines), lines)
	}
	if lines[0] != `{"schema":1,"ts":"t0","kind":"session_start","sessionId":"a"}` {
		t.Fatalf("first line mismatch: %s", lines[0])
	}
}

func TestAppendRejectsMalformedJSON(t *testing.T) {
	dir := t.TempDir()
	if err := Append(dir, "not json {"); err == nil {
		t.Fatal("want error for malformed json")
	}
	if _, err := os.Stat(filepath.Join(dir, TrailFileName)); !os.IsNotExist(err) {
		t.Fatalf("file should not exist, err=%v", err)
	}
}

func TestReadLinesLimitKeepsTail(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 10; i++ {
		if err := Append(dir, `{"n":1}`); err != nil {
			t.Fatal(err)
		}
	}
	lines := ReadLines(dir, 3)
	if len(lines) != 3 {
		t.Fatalf("want 3 lines, got %d", len(lines))
	}
}
