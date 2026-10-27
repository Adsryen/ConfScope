package ssh

// known_hosts 的判据用例（r104）。
//
// 这一层是「SSH 隧道主机密钥校验」的地基：格式必须与 OpenSSH 的
// known_hosts 行格式一致（用户拿自己的 OpenSSH 记录来不能被拒），
// 写入必须是「同一条记录只认一把钥匙」，否则指纹变更会被第二把钥匙绕过去。

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/ssh"
)

// ed25519VectorKey 是 ssh-keygen 真实生成的 ed25519 公钥（2026-10-27 固定向量）：
//
//	ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFNILLUSmXp7EDdqw6VRJEfFVWBjStLgge1ZNzdnHr3z r104-test-vector
//
// wire 字节 = 4 字节长度 + "ssh-ed25519" + 32 字节原始公钥，与 OpenSSH 写盘的形式一致。
const ed25519VectorKeyB64 = "AAAAC3NzaC1lZDI1NTE5AAAAIFNILLUSmXp7EDdqw6VRJEfFVWBjStLgge1ZNzdnHr3z"

func testServerKey(t *testing.T) (ssh.PublicKey, []byte) {
	t.Helper()

	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	key, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatalf("NewPublicKey: %v", err)
	}
	return key, key.Marshal()
}

func writeKnownHostsFile(t *testing.T, path string, content string) {
	t.Helper()

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

// R1：行格式与 OpenSSH 兼容 —— 固定向量比对一条真实形状的 host,keytype,base64 行。
func TestKnownHostsParsesOpenSSHLineVector(t *testing.T) {
	line := "jump.example.com ssh-ed25519 " + ed25519VectorKeyB64 + " r104-test-vector"
	parsed, ok := parseKnownHostsLine(line)
	if !ok {
		t.Fatalf("parseKnownHostsLine(%q) = not ok", line)
	}
	if len(parsed.hosts) != 1 || parsed.hosts[0] != "jump.example.com" {
		t.Fatalf("hosts = %v, want [jump.example.com]", parsed.hosts)
	}
	if parsed.keyType != "ssh-ed25519" {
		t.Fatalf("keyType = %q, want ssh-ed25519", parsed.keyType)
	}
	if parsed.keyB64 != ed25519VectorKeyB64 {
		t.Fatalf("keyB64 = %q, want vector", parsed.keyB64)
	}
	if !bytes.Equal(parsed.key, mustDecode(t, ed25519VectorKeyB64)) {
		t.Fatal("key wire bytes != 向量的 base64 解码结果")
	}
}

func TestKnownHostsWritesOpenSSHCompatibleLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	kh := NewKnownHosts(path)

	key, wire := testServerKey(t)
	if err := kh.Add("jump.example.com", 2222, key.Type(), base64.StdEncoding.EncodeToString(wire)); err != nil {
		t.Fatalf("Add: %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 1 {
		t.Fatalf("写入行数 = %d, want 1: %q", len(lines), raw)
	}
	want := "jump.example.com:2222 " + key.Type() + " " + base64.StdEncoding.EncodeToString(wire)
	if lines[0] != want {
		t.Fatalf("写入行 = %q, want OpenSSH 形状 %q", lines[0], want)
	}
}

// 固定向量的 SHA256 指纹：SHA256: + 无填充 base64（与 ssh-keygen -lf 的输出形式一致）。
func TestFingerprintUsesOpenSSHSHA256Form(t *testing.T) {
	raw := mustDecode(t, ed25519VectorKeyB64)
	fp := fingerprintOf(raw)
	if !strings.HasPrefix(fp, "SHA256:") {
		t.Fatalf("fingerprint = %q, want SHA256: 前缀", fp)
	}
	body := strings.TrimPrefix(fp, "SHA256:")
	if len(body) != 43 {
		t.Fatalf("指纹主体长度 = %d, want 43（32 字节摘要的无填充 base64）: %q", len(body), body)
	}
}

func TestKnownHostsLookupPortPinning(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	// 一台机器的两个身份：2222 端口的固定记录，与任意端口的裸主机记录。
	writeKnownHostsFile(t, path, strings.Join([]string{
		"jump.example.com:2222 ssh-ed25519 " + ed25519VectorKeyB64,
		"other.example.com ssh-ed25519 " + ed25519VectorKeyB64,
	}, "\n")+"\n")

	kh := NewKnownHosts(path)

	if got := kh.lookup("jump.example.com", 2222); len(got) != 1 {
		t.Fatalf("lookup(jump:2222) = %d 条, want 1", len(got))
	}
	if got := kh.lookup("jump.example.com", 22); len(got) != 0 {
		t.Fatalf("lookup(jump:22) = %d 条, want 0 —— 2222 的固定记录不得覆盖 22 端口", len(got))
	}
	if got := kh.lookup("other.example.com", 2222); len(got) != 1 {
		t.Fatalf("lookup(other:2222) = %d 条, want 1 —— 裸主机记录匹配任意端口", len(got))
	}
	if got := kh.lookup("other.example.com", 22); len(got) != 1 {
		t.Fatalf("lookup(other:22) = %d 条, want 1", len(got))
	}
}

func TestKnownHostsLookupIPWithBracketedPort(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	writeKnownHostsFile(t, path, "[10.0.0.7]:2222 ssh-ed25519 "+ed25519VectorKeyB64+"\n")

	kh := NewKnownHosts(path)

	if got := kh.lookup("10.0.0.7", 2222); len(got) != 1 {
		t.Fatalf("lookup(10.0.0.7:2222) = %d 条, want 1", len(got))
	}
	if got := kh.lookup("10.0.0.7", 22); len(got) != 0 {
		t.Fatalf("lookup(10.0.0.7:22) = %d 条, want 0", len(got))
	}
}

func TestKnownHostsWildcardPatterns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	writeKnownHostsFile(t, path, strings.Join([]string{
		"*.corp.example.com ssh-ed25519 " + ed25519VectorKeyB64,
		".corp.example.com ssh-ed25519 " + ed25519VectorKeyB64,
		"* ssh-ed25519 " + ed25519VectorKeyB64,
	}, "\n")+"\n")

	kh := NewKnownHosts(path)

	for _, host := range []string{"a.corp.example.com", "corp.example.com", "whatever.host"} {
		if got := kh.lookup(host, 22); len(got) == 0 {
			t.Fatalf("lookup(%s) 未命中任何通配记录", host)
		}
	}
	if got := kh.lookup("corp.example.com.evil.net", 22); len(got) != 1 {
		// 只有 "*" 能命中这个伪装域名：.corp.example.com 不得匹配「结尾是 corp.example.com.evil.net」以外的东西，
		// *.corp.example.com 同理。命中数 = 恰好 "*" 那一条。
		t.Fatalf("lookup(伪装域名) = %d 条, want 1（仅 *）", len(got))
	}
}

// R1：注释、空行、@ 标记行都得被正确跳过（用户的 OpenSSH 文件里常见）。
func TestKnownHostsSkipsCommentsBlankAndMarkerLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	writeKnownHostsFile(t, path, strings.Join([]string{
		"# a comment line",
		"",
		"@revoked jump.example.com ssh-ed25519 " + ed25519VectorKeyB64,
		"@cert-authority ca.example.com ssh-ed25519 " + ed25519VectorKeyB64,
		"jump.example.com ssh-ed25519 " + ed25519VectorKeyB64,
	}, "\n")+"\n")

	kh := NewKnownHosts(path)

	// 被 @revoked 标记的那行不得进入可信池：这里只剩裸主机一条有效记录。
	if got := kh.lookup("jump.example.com", 22); len(got) != 1 {
		t.Fatalf("lookup(jump) = %d 条, want 1（注释/空行/@标记行均跳过）", len(got))
	}
}

// R2/R3 的地基：同一条记录只认一把钥匙。已有不同钥匙时拒绝追加，
// 否则「旧记录 + 新钥匙」两条并存会把指纹变更的硬阻断变成并集信任。
func TestKnownHostsAddRefusesDifferentKeyForSameRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	kh := NewKnownHosts(path)

	keyA, wireA := testServerKey(t)
	if err := kh.Add("jump.example.com", 2222, keyA.Type(), base64.StdEncoding.EncodeToString(wireA)); err != nil {
		t.Fatalf("Add(A): %v", err)
	}

	keyB, wireB := testServerKey(t)
	err := kh.Add("jump.example.com", 2222, keyB.Type(), base64.StdEncoding.EncodeToString(wireB))
	if err == nil {
		t.Fatal("Add(B) 成功，want 拒绝 —— 同一记录已有不同钥匙")
	}

	raw, _ := os.ReadFile(path)
	if strings.Count(string(raw), base64.StdEncoding.EncodeToString(wireA)) != 1 {
		t.Fatalf("文件里 A 的记录数异常: %q", raw)
	}
	if strings.Contains(string(raw), base64.StdEncoding.EncodeToString(wireB)) {
		t.Fatal("B 被写进了文件，want 只留 A")
	}

	// 同一把钥匙重复信任是幂等的。
	if err := kh.Add("jump.example.com", 2222, keyA.Type(), base64.StdEncoding.EncodeToString(wireA)); err != nil {
		t.Fatalf("重复信任同一把钥匙应当幂等, got %v", err)
	}
}

func TestKnownHostsAddRejectsInvalidKey(t *testing.T) {
	kh := NewKnownHosts(filepath.Join(t.TempDir(), "known_hosts"))

	if err := kh.Add("jump.example.com", 22, "", "!!!not-base64!!!"); err == nil {
		t.Fatal("非法 base64 应当被拒绝")
	}
	garbage := base64.StdEncoding.EncodeToString([]byte("definitely not a public key"))
	if err := kh.Add("jump.example.com", 22, "ssh-ed25519", garbage); err == nil {
		t.Fatal("不是公钥字节的 base64 应当被拒绝")
	}
}

// 2026-10-27 真机复检复现 B 收编：Add 不校验 host 时能写出通配记录
// （同一把钥匙在所有主机上放行）与换行注入（一条完整的新记录）。
// 判据：这些 host 一律拒绝，且落盘文件不得留下任何内容。
func TestKnownHostsAddRejectsImpreciseHosts(t *testing.T) {
	key, wire := testServerKey(t)
	b64 := base64.StdEncoding.EncodeToString(wire)

	cases := []struct {
		name string
		host string
	}{
		{"通配星", "*"},
		{"域通配", "*.example.com"},
		{"点前缀通配", ".example.com"},
		{"逗号主机列表", "a.example.com,b.example.com"},
		{"含空格", "jump example.com"},
		{"含换行注入", "ok.example.com\nevil.example.com ssh-ed25519 " + ed25519VectorKeyB64},
		{"超长标签", strings.Repeat("a", 64) + ".example.com"},
		{"超长总长", strings.Repeat("a", 64) + "." + strings.Repeat("a", 64) + "." + strings.Repeat("a", 64) + "." + strings.Repeat("a", 60)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "known_hosts")
			kh := NewKnownHosts(path)
			if err := kh.Add(tc.host, 22, key.Type(), b64); err == nil {
				t.Fatalf("Add(%q) 成功，want 拒绝", tc.host)
			}
			raw, _ := os.ReadFile(path)
			if len(raw) != 0 {
				t.Fatalf("被拒的 host 仍在文件留下内容: %q", raw)
			}
		})
	}
}

// Add 的端口是显式契约：1..65535 之外（含 0 这种「静默归一」的旧口子）一律拒绝。
func TestKnownHostsAddRejectsOutOfRangePort(t *testing.T) {
	key, wire := testServerKey(t)
	b64 := base64.StdEncoding.EncodeToString(wire)

	for _, port := range []int{-1, 0, 65536, 1 << 20} {
		t.Run(fmt.Sprintf("port=%d", port), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "known_hosts")
			kh := NewKnownHosts(path)
			if err := kh.Add("jump.example.com", port, key.Type(), b64); err == nil {
				t.Fatalf("Add(port=%d) 成功，want 拒绝", port)
			}
			if raw, _ := os.ReadFile(path); len(raw) != 0 {
				t.Fatalf("越界端口仍在文件留下内容: %q", raw)
			}
		})
	}
}

// 精确身份的正向面：主机名与 IP（含 IPv6）、端口边界 1 与 65535 都要放行。
func TestKnownHostsAddAcceptsExactIdentities(t *testing.T) {
	key, wire := testServerKey(t)
	b64 := base64.StdEncoding.EncodeToString(wire)

	hosts := []string{"jump.example.com", "sub.domain.example.com", "10.0.0.7", "::1"}
	ports := []int{1, 22, 2222, 65535}
	for _, host := range hosts {
		for _, port := range ports {
			t.Run(fmt.Sprintf("%s:%d", host, port), func(t *testing.T) {
				path := filepath.Join(t.TempDir(), "known_hosts")
				kh := NewKnownHosts(path)
				if err := kh.Add(host, port, key.Type(), b64); err != nil {
					t.Fatalf("Add(%q, %d) 拒绝了合法的精确身份: %v", host, port, err)
				}
			})
		}
	}
}

// R2：写入后重新打开仍可读（重启后记录不丢）。
func TestKnownHostsAddSurvivesReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ssh/known_hosts")
	kh := NewKnownHosts(path)

	key, wire := testServerKey(t)
	if err := kh.Add("jump.example.com", 2222, key.Type(), base64.StdEncoding.EncodeToString(wire)); err != nil {
		t.Fatalf("Add: %v", err)
	}

	reopened := NewKnownHosts(path)
	if got := reopened.lookup("jump.example.com", 2222); len(got) != 1 {
		t.Fatalf("重新打开后 lookup = %d 条, want 1", len(got))
	}
}

// R4：并发追加不得丢行（两条连接同时首信不同主机）。
func TestKnownHostsConcurrentAddKeepsEveryRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	kh := NewKnownHosts(path)

	const hosts = 8
	var wg sync.WaitGroup
	errs := make(chan error, hosts)
	for i := 0; i < hosts; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			key, wire := testServerKey(t)
			host := fmt.Sprintf("host-%d.example.com", i)
			if err := kh.Add(host, 22, key.Type(), base64.StdEncoding.EncodeToString(wire)); err != nil {
				errs <- fmt.Errorf("host-%d: %w", i, err)
			}
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	for i := 0; i < hosts; i++ {
		if !strings.Contains(string(raw), fmt.Sprintf("host-%d.example.com ", i)) {
			t.Fatalf("并发写后丢失 host-%d 的记录:\n%s", i, raw)
		}
	}
}

// recordID：22 端口写裸主机（与 OpenSSH 习惯一致），非 22 端口写 host:port，
// IP 字面量加方括号。
func TestRecordIDShapes(t *testing.T) {
	cases := []struct {
		host string
		port int
		want string
	}{
		{"jump.example.com", 22, "jump.example.com"},
		{"jump.example.com", 0, "jump.example.com"},
		{"jump.example.com", 2222, "jump.example.com:2222"},
		{"10.0.0.7", 2222, "[10.0.0.7]:2222"},
		{"10.0.0.7", 22, "10.0.0.7"},
	}
	for _, tc := range cases {
		if got := recordID(tc.host, tc.port); got != tc.want {
			t.Fatalf("recordID(%s, %d) = %q, want %q", tc.host, tc.port, got, tc.want)
		}
	}
}

// 多主机逗号列表与带注释的行也要能解析。
func TestKnownHostsParsesMultiHostLine(t *testing.T) {
	parsed, ok := parseKnownHostsLine("a.example.com,b.example.com ssh-ed25519 " + ed25519VectorKeyB64 + " team@laptop")
	if !ok {
		t.Fatal("多主机行解析失败")
	}
	if len(parsed.hosts) != 2 || parsed.hosts[0] != "a.example.com" || parsed.hosts[1] != "b.example.com" {
		t.Fatalf("hosts = %v, want 两个主机", parsed.hosts)
	}
}

func mustDecode(t *testing.T, b64 string) []byte {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatalf("base64 解码向量失败: %v", err)
	}
	return raw
}
