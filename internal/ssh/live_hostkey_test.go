package ssh

// 真机判据（r104）：对着容器 sshd（默认 127.0.0.1:2223）跑真实的
// 首次确认与指纹变更裁决。
//
//   - TestLiveSSHDFirstTrustFlow：默认地址恒跑（可达时）。全新 known_hosts →
//     裁决 hostKeyUnknown 并给出指纹；用户确认写入 → 裁决 trusted。
//   - TestLiveSSHDKeyChangeIsBlocked：CONFSCOPE_LIVE_SSHD_ALT 指向另一台
//     换了主机密钥的 sshd，CONFSCOPE_LIVE_EXPECT=changed 时断言硬阻断。
//     这条需要真机换 key，不在默认路径里——由验证脚本起临时 sshd 驱动。
//
// 地址不可达时跳过：真机缺席不等于代码有问题，CI 不该因此判红。

import (
	"encoding/base64"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func liveSSHDDefaultAddr() string {
	if addr := os.Getenv("CONFSCOPE_LIVE_SSHD"); addr != "" {
		return addr
	}
	return "127.0.0.1:2223"
}

func liveSSHDReachable(addr string) bool {
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func liveHostKeyConfig(t *testing.T, addr string) (Config, string, int) {
	t.Helper()

	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("SplitHostPort(%s): %v", addr, err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("端口解析失败: %v", err)
	}
	return Config{Host: host, Port: port, Username: "root", AuthType: "password"}, host, port
}

// 真机首次确认：未知 → 确认指纹 → 信任。每一步都对着真实 sshd 的握手。
func TestLiveSSHDFirstTrustFlow(t *testing.T) {
	addr := liveSSHDDefaultAddr()
	if !liveSSHDReachable(addr) {
		t.Skipf("容器 sshd %s 不可达，跳过真机首信用例", addr)
	}
	cfg, host, port := liveHostKeyConfig(t, addr)

	khPath := filepath.Join(t.TempDir(), "known_hosts")
	manager := NewManager(func() string { return khPath })

	status, err := manager.ProbeHostKey(cfg)
	if err != nil {
		t.Fatalf("ProbeHostKey: %v", err)
	}
	if status.Status != HostKeyUnknown {
		t.Fatalf("全新 known_hosts 首次探测 = %q, want hostKeyUnknown", status.Status)
	}
	if status.Fingerprint == "" || status.KeyType == "" {
		t.Fatalf("未知主机裁决没带指纹/算法: %+v", status)
	}
	t.Logf("真机首信裁决: %s %s %s", status.RecordID, status.KeyType, status.Fingerprint)

	if err := manager.TrustHostKey(host, port, status.KeyType, status.KeyBase64); err != nil {
		t.Fatalf("TrustHostKey: %v", err)
	}

	reprobe, err := manager.ProbeHostKey(cfg)
	if err != nil {
		t.Fatalf("再次 ProbeHostKey: %v", err)
	}
	if reprobe.Status != HostKeyTrusted {
		t.Fatalf("确认后裁决 = %q, want trusted", reprobe.Status)
	}
	if reprobe.Fingerprint != status.Fingerprint {
		t.Fatalf("两次裁决指纹不一致: %q vs %q", reprobe.Fingerprint, status.Fingerprint)
	}
}

// livePresentedKey 对真实 sshd 拨一次号，取回它出示的主机密钥。
// 认证会失败（不凭据），但失败发生在主机密钥交换「之后」——取回钥匙即完成判据所需。
func livePresentedKey(t *testing.T, addr string) ssh.PublicKey {
	t.Helper()

	var presented ssh.PublicKey
	cfg := &ssh.ClientConfig{
		User: "root",
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			presented = key
			return nil
		},
		Timeout: 5 * time.Second,
	}
	c, err := ssh.Dial("tcp", addr, cfg)
	if c != nil {
		_ = c.Close()
	}
	if presented == nil {
		t.Fatalf("取不到主机密钥: %v", err)
	}
	return presented
}

// 真机「信任后真实拨号」：信任落盘之后，走 createSSHConfig + 真实 ssh.Dial
// 的隧道路径再拨一次。判据：不得命中任何主机密钥阻断。
//
// 这是 2026-10-27 真机复检复现 A 的收编用例——当时 x/crypto 交给回调的是
// 带端口的拨号地址，产品代码比的是裸主机名，所有已信任主机在真实拨号时
// 都被误判成「密钥变更」。假 dialer 的用例只能钉住「带端口要能归一」，
// 这条对着真实握手，钉住整条链。判据不需要凭据：主机密钥被拒会在握手
// 阶段就报错，钥匙放行才会走到认证阶段（故意给错口令，认证失败是预期结局）。
func TestLiveSSHDTrustedHostSurvivesRealDial(t *testing.T) {
	addr := liveSSHDDefaultAddr()
	if !liveSSHDReachable(addr) {
		t.Skipf("容器 sshd %s 不可达，跳过真机信任后拨号用例", addr)
	}
	cfg, host, port := liveHostKeyConfig(t, addr)

	khPath := filepath.Join(t.TempDir(), "known_hosts")
	kh := NewKnownHosts(khPath)
	presented := livePresentedKey(t, addr)
	if err := kh.Add(host, port, presented.Type(), base64.StdEncoding.EncodeToString(presented.Marshal())); err != nil {
		t.Fatalf("Add: %v", err)
	}
	raw, _ := os.ReadFile(khPath)
	t.Logf("known_hosts 内容: %q", string(raw))

	cfg.Password = "wrong-on-purpose"
	clientCfg, err := createSSHConfig(cfg, kh)
	if err != nil {
		t.Fatalf("createSSHConfig: %v", err)
	}
	conn, dialErr := ssh.Dial("tcp", addr, clientCfg)
	if conn != nil {
		_ = conn.Close()
	}
	t.Logf("信任后走隧道真实拨号路径 err=%v", dialErr)
	if dialErr != nil {
		var hke *HostKeyError
		if asHostKeyError(dialErr, &hke) {
			t.Fatalf("已信任的主机在真实拨号路径被主机密钥阻断: %v", dialErr)
		}
	}
}

// 真机主机密钥三阶段：对同一台临时 sshd 与同一份持久 known_hosts 走完整生命周期。
//
//	CONFSCOPE_LIVE_EXPECT=unknown  全新记录，首次探测 → hostKeyUnknown
//	CONFSCOPE_LIVE_EXPECT=trusted  探测 → 用户确认（信任落盘）→ 复探 → trusted
//	CONFSCOPE_LIVE_EXPECT=changed  服务器换过主机密钥，记录里还是旧钥匙 → 硬阻断
//
// CONFSCOPE_LIVE_KNOWN_HOSTS 指定持久记录文件（跨轮次生效）；不指定则用一次性
// 临时目录，此时只有 unknown 阶段有意义。由验证脚本换 key 前后各驱动一轮。
func TestLiveSSHDKeyChangeIsBlocked(t *testing.T) {
	addr := os.Getenv("CONFSCOPE_LIVE_SSHD_ALT")
	if addr == "" {
		t.Skip("CONFSCOPE_LIVE_SSHD_ALT 未设置，跳过真机换 key 用例")
	}
	if !liveSSHDReachable(addr) {
		t.Skipf("换 key 的 sshd %s 不可达，跳过", addr)
	}
	expect := os.Getenv("CONFSCOPE_LIVE_EXPECT")
	if expect == "" {
		t.Skip("CONFSCOPE_LIVE_EXPECT 未设置，跳过")
	}
	cfg, host, port := liveHostKeyConfig(t, addr)

	khPath := os.Getenv("CONFSCOPE_LIVE_KNOWN_HOSTS")
	if khPath == "" {
		khPath = filepath.Join(t.TempDir(), "known_hosts")
	}
	manager := NewManager(func() string { return khPath })

	status, err := manager.ProbeHostKey(cfg)
	if err != nil {
		t.Fatalf("ProbeHostKey: %v", err)
	}
	switch expect {
	case "unknown":
		if status.Status != HostKeyUnknown {
			t.Fatalf("裁决 = %q, want hostKeyUnknown（record=%s fp=%s）", status.Status, status.RecordID, status.Fingerprint)
		}
		t.Logf("真机换 key 用例（全新记录）: %s %s %s → unknown", status.RecordID, status.KeyType, status.Fingerprint)
	case "trusted":
		if status.Status != HostKeyUnknown {
			t.Fatalf("信任前裁决 = %q, want hostKeyUnknown", status.Status)
		}
		if err := manager.TrustHostKey(host, port, status.KeyType, status.KeyBase64); err != nil {
			t.Fatalf("TrustHostKey: %v", err)
		}
		reprobe, err := manager.ProbeHostKey(cfg)
		if err != nil {
			t.Fatalf("信任后复探: %v", err)
		}
		if reprobe.Status != HostKeyTrusted {
			t.Fatalf("信任后裁决 = %q, want trusted", reprobe.Status)
		}
		t.Logf("真机换 key 用例（信任链路）: %s 信任后复探 → trusted（fp=%s）", status.RecordID, reprobe.Fingerprint)
	case "changed":
		if status.Status != HostKeyChanged {
			t.Fatalf("裁决 = %q, want hostKeyChanged（出示=%s 记录=%s）", status.Status, status.Fingerprint, status.RecordFingerprint)
		}
		t.Logf("真机换 key 用例（换 key 阻断）: %s 记录指纹=%s 出示指纹=%s → changed", status.RecordID, status.RecordFingerprint, status.Fingerprint)
	default:
		t.Fatalf("不认识的 CONFSCOPE_LIVE_EXPECT=%q（只支持 unknown/trusted/changed）", expect)
	}
}
