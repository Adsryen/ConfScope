package ssh

// 主机密钥校验的隧道/管理器层判据（r104）。
//
// 这里的 dialer 是假的，但「握手时先过 HostKeyCallback」这一行为是真的：
// 它模拟 SSH 握手的第一步——服务端出示主机密钥、客户端当场裁决。
// 校验不过就建不了连接，这条因果不依赖真实网络。

import (
	"encoding/base64"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"golang.org/x/crypto/ssh"
)

// keyPresentingDialer 扮演一台 SSH 服务器：拨号即出示 hostKey。
// 客户端配置的 HostKeyCallback 拒绝它，本次「连接」就地失败。
type keyPresentingDialer struct {
	host     string
	port     int
	key      ssh.PublicKey
	dials    atomic.Int32
	hostname string // 回调收到的主机名；默认为带端口的拨号地址
}

func (d *keyPresentingDialer) dial(addr string, cfg *ssh.ClientConfig) (sshClientConn, error) {
	d.dials.Add(1)
	if cfg == nil || cfg.HostKeyCallback == nil {
		return nil, errMissingHostKeyCallback
	}
	hostname := d.hostname
	if hostname == "" {
		// 与真实握手一致：x/crypto 传给 HostKeyCallback 的是拨号地址
		// （tunnel.go 用 net.JoinHostPort 拼出，带端口），不是裸主机名。
		// 替身不给错值，否则这条路径的差异被抹平（2026-10-27 复检复现 A）。
		hostname = net.JoinHostPort(d.host, strconv.Itoa(d.port))
	}
	if err := cfg.HostKeyCallback(hostname, nil, d.key); err != nil {
		return nil, err
	}
	return &fakeClient{}, nil
}

var errMissingHostKeyCallback = errStatic("ClientConfig 没有 HostKeyCallback —— 校验缺失，拒绝拨号")

type errStatic string

func (e errStatic) Error() string { return string(e) }

func hostKeyConfig(host string, port int) Config {
	return Config{
		Host:       host,
		Port:       port,
		Username:   "root",
		AuthType:   "password",
		Password:   "top-secret-pw-123",
		PrivateKey: "secret-key-material",
		Passphrase: "secret-pass-456",
		RemoteHost: "nacos.internal",
		RemotePort: 8848,
	}
}

// R2：未知主机 → hostKeyUnknown，不建连；错误里带算法/指纹/记录位置。
func TestTunnelStartUnknownHostIsBlocked(t *testing.T) {
	kh := NewKnownHosts(filepath.Join(t.TempDir(), "known_hosts"))
	serverKey, wire := testServerKey(t)
	cfg := hostKeyConfig("jump-a.example.com", 2223)

	tunnel := NewTunnel(cfg, kh)
	tunnel.dialer = (&keyPresentingDialer{host: cfg.Host, port: cfg.Port, key: serverKey}).dial

	port, err := tunnel.Start()
	if port != 0 {
		t.Fatalf("未知主机却拿到了端口 %d", port)
	}
	var hke *HostKeyError
	if !asHostKeyError(err, &hke) {
		t.Fatalf("err = %v, want *HostKeyError", err)
	}
	if hke.Verdict != HostKeyUnknown {
		t.Fatalf("Verdict = %q, want hostKeyUnknown", hke.Verdict)
	}
	if hke.KeyType != "ssh-ed25519" {
		t.Fatalf("KeyType = %q, want ssh-ed25519", hke.KeyType)
	}
	if hke.Fingerprint != fingerprintOf(wire) {
		t.Fatalf("Fingerprint = %q, want %q", hke.Fingerprint, fingerprintOf(wire))
	}
	if !strings.Contains(err.Error(), fingerprintOf(wire)) {
		t.Fatalf("错误文案没有带指纹: %q", err.Error())
	}
	// R5：凭据一个字都不许进错误文案。
	for _, secret := range []string{"top-secret-pw-123", "secret-key-material", "secret-pass-456"} {
		if strings.Contains(err.Error(), secret) {
			t.Fatalf("错误文案泄漏凭据 %q: %q", secret, err.Error())
		}
	}
	// 未信任 ⇒ known_hosts 里不得有这条记录。
	raw, _ := os.ReadFile(kh.Path())
	if strings.Contains(string(raw), base64.StdEncoding.EncodeToString(wire)) {
		t.Fatal("未确认的主机密钥被写进了 known_hosts")
	}
}

// R2：确认后写入并建连。
func TestTunnelStartKnownHostConnects(t *testing.T) {
	kh := NewKnownHosts(filepath.Join(t.TempDir(), "known_hosts"))
	serverKey, wire := testServerKey(t)
	cfg := hostKeyConfig("jump-a.example.com", 2223)
	if err := kh.Add(cfg.Host, cfg.Port, serverKey.Type(), base64.StdEncoding.EncodeToString(wire)); err != nil {
		t.Fatalf("Add: %v", err)
	}

	tunnel := NewTunnel(cfg, kh)
	tunnel.dialer = (&keyPresentingDialer{host: cfg.Host, port: cfg.Port, key: serverKey}).dial

	port, err := tunnel.Start()
	if err != nil {
		t.Fatalf("已信任主机建连失败: %v", err)
	}
	if port <= 0 {
		t.Fatal("建连成功但端口为 0")
	}
	tunnel.Stop()
}

// R3：指纹变更 → hostKeyChanged，硬阻断；文案说明中间人风险与记录位置。
func TestTunnelStartChangedHostKeyIsBlocked(t *testing.T) {
	khPath := filepath.Join(t.TempDir(), "known_hosts")
	kh := NewKnownHosts(khPath)
	cfg := hostKeyConfig("jump-a.example.com", 2223)

	recordedKey, recordedWire := testServerKey(t)
	if err := kh.Add(cfg.Host, cfg.Port, recordedKey.Type(), base64.StdEncoding.EncodeToString(recordedWire)); err != nil {
		t.Fatalf("Add: %v", err)
	}
	attackerKey, attackerWire := testServerKey(t)

	tunnel := NewTunnel(cfg, kh)
	tunnel.dialer = (&keyPresentingDialer{host: cfg.Host, port: cfg.Port, key: attackerKey}).dial

	_, err := tunnel.Start()
	var hke *HostKeyError
	if !asHostKeyError(err, &hke) {
		t.Fatalf("err = %v, want *HostKeyError", err)
	}
	if hke.Verdict != HostKeyChanged {
		t.Fatalf("Verdict = %q, want hostKeyChanged", hke.Verdict)
	}
	text := err.Error()
	if !strings.Contains(text, fingerprintOf(recordedWire)) {
		t.Fatalf("变更文案没有带已记录指纹: %q", text)
	}
	if !strings.Contains(text, fingerprintOf(attackerWire)) {
		t.Fatalf("变更文案没有带对方出示的指纹: %q", text)
	}
	if !strings.Contains(text, khPath) {
		t.Fatalf("变更文案没有给出记录位置: %q", text)
	}
}

// 回调收到的主机名与拨号目标不一致（将来若有人换目标）：按身份不符阻断，不猜。
func TestHostKeyCallbackBlocksHostnameMismatch(t *testing.T) {
	kh := NewKnownHosts("")
	serverKey, wire := testServerKey(t)
	if err := kh.Add("jump-a.example.com", 22, serverKey.Type(), base64.StdEncoding.EncodeToString(wire)); err != nil {
		t.Fatalf("Add: %v", err)
	}

	err := kh.HostKeyCallback("jump-a.example.com", 22)("other.example.com", nil, serverKey)
	if err == nil {
		t.Fatal("主机名不一致应当被阻断")
	}
	var hke *HostKeyError
	if !asHostKeyError(err, &hke) || hke.Verdict != HostKeyMismatch {
		t.Fatalf("err = %v, want hostKeyMismatch（身份不符不是密钥变更，文案不得引导删记录）", err)
	}
	if hke.Hostname != "other.example.com" {
		t.Fatalf("Hostname = %q, want other.example.com", hke.Hostname)
	}
}

// x/crypto 交给回调的 hostname 是带端口的拨号地址（tunnel.go 用
// net.JoinHostPort 拼出）。已信任的主机在真实拨号下不得被误判成
// 「密钥变更」——2026-10-27 真机复检复现（repro A）收成的回归判据。
func TestHostKeyCallbackNormalizesDialAddressWithPort(t *testing.T) {
	kh := NewKnownHosts("")
	serverKey, wire := testServerKey(t)
	if err := kh.Add("jump-a.example.com", 2223, serverKey.Type(), base64.StdEncoding.EncodeToString(wire)); err != nil {
		t.Fatalf("Add: %v", err)
	}

	// 非 22 端口：拨号地址带端口，必须命中自己的记录。
	if err := kh.HostKeyCallback("jump-a.example.com", 2223)(net.JoinHostPort("jump-a.example.com", "2223"), nil, serverKey); err != nil {
		t.Fatalf("带端口的真实拨号地址被误判: %v", err)
	}
	// 22 端口同样成立：x/crypto 传的永远是拨号地址，没有「裸主机名」一说。
	if err := kh.Add("10.0.0.7", 22, serverKey.Type(), base64.StdEncoding.EncodeToString(wire)); err != nil {
		t.Fatalf("Add(10.0.0.7): %v", err)
	}
	if err := kh.HostKeyCallback("10.0.0.7", 22)(net.JoinHostPort("10.0.0.7", "22"), nil, serverKey); err != nil {
		t.Fatalf("22 端口的带端口拨号地址被误判: %v", err)
	}
	// IPv6 的拨号地址带方括号与端口，剥掉之后也要命中。
	if err := kh.Add("::1", 2223, serverKey.Type(), base64.StdEncoding.EncodeToString(wire)); err != nil {
		t.Fatalf("Add(::1): %v", err)
	}
	if err := kh.HostKeyCallback("::1", 2223)(net.JoinHostPort("::1", "2223"), nil, serverKey); err != nil {
		t.Fatalf("IPv6 带端口的拨号地址被误判: %v", err)
	}
}

// R4：同一份 known_hosts 被多个连接共享；复用判定不绕过校验。
func TestManagerSharesKnownHostsAcrossConnections(t *testing.T) {
	khPath := filepath.Join(t.TempDir(), "known_hosts")
	manager := NewManager(func() string { return khPath })
	serverKey, wire := testServerKey(t)
	keyB64 := base64.StdEncoding.EncodeToString(wire)
	cfg := hostKeyConfig("jump-a.example.com", 2223)

	dialer := &keyPresentingDialer{host: cfg.Host, port: cfg.Port, key: serverKey}
	manager.newTunnel = func(config Config, hostKeys *KnownHosts) *Tunnel {
		tunnel := NewTunnel(config, hostKeys)
		tunnel.dialer = dialer.dial
		return tunnel
	}

	// 首信：未知主机，建不了。
	_, err := manager.CreateTunnel("conn-a", cfg)
	var hke *HostKeyError
	if !asHostKeyError(err, &hke) || hke.Verdict != HostKeyUnknown {
		t.Fatalf("首次建连 = %v, want hostKeyUnknown", err)
	}
	if got := manager.GetTunnel("conn-a"); got != nil {
		t.Fatal("建连失败却留了隧道实例")
	}

	// 用户确认指纹 → 信任。
	if err := manager.TrustHostKey(cfg.Host, cfg.Port, serverKey.Type(), keyB64); err != nil {
		t.Fatalf("TrustHostKey: %v", err)
	}

	// 两条不同连接、同一主机：都要重新拨号并各自过校验。
	// 拨号计数 = 首信被拒的 1 次 + 这两条各 1 次（被拒那一次是真实的：
	// 拨了号、服务器出示了钥匙、校验没放行，连接没有建立）。
	portA, err := manager.CreateTunnel("conn-a", cfg)
	if err != nil {
		t.Fatalf("信任后 conn-a 建连失败: %v", err)
	}
	portB, err := manager.CreateTunnel("conn-b", cfg)
	if err != nil {
		t.Fatalf("信任后 conn-b 建连失败: %v", err)
	}
	if want := int32(3); dialer.dials.Load() != want {
		t.Fatalf("拨号次数 = %d, want %d（被拒首信 1 + 两条连接各 1）", dialer.dials.Load(), want)
	}
	if portA <= 0 || portB <= 0 {
		t.Fatalf("端口 = %d/%d, want 均为正", portA, portB)
	}

	// 复用判定：同配置再来一次，直接给已有端口，不再拨号。
	reused, err := manager.CreateTunnel("conn-a", cfg)
	if err != nil {
		t.Fatalf("复用建连失败: %v", err)
	}
	if reused != portA {
		t.Fatalf("复用端口 = %d, want %d", reused, portA)
	}
	if want := int32(3); dialer.dials.Load() != want {
		t.Fatalf("复用又去拨号了：拨号次数 = %d, want 仍为 %d", dialer.dials.Load(), want)
	}

	// 同一主机只有一份记录。
	raw, err := os.ReadFile(khPath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if n := strings.Count(string(raw), keyB64); n != 1 {
		t.Fatalf("known_hosts 里该主机的记录数 = %d, want 1:\n%s", n, raw)
	}
	manager.StopAll()
}

// R5：指纹变更的阻断里也不许带凭据。
func TestHostKeyChangedErrorNeverLeaksCredentials(t *testing.T) {
	kh := NewKnownHosts(filepath.Join(t.TempDir(), "known_hosts"))
	cfg := hostKeyConfig("jump-a.example.com", 2223)
	recordedKey, recordedWire := testServerKey(t)
	if err := kh.Add(cfg.Host, cfg.Port, recordedKey.Type(), base64.StdEncoding.EncodeToString(recordedWire)); err != nil {
		t.Fatalf("Add: %v", err)
	}
	attackerKey, _ := testServerKey(t)

	err := kh.HostKeyCallback(cfg.Host, cfg.Port)("jump-a.example.com", nil, attackerKey)
	for _, secret := range []string{"top-secret-pw-123", "secret-key-material", "secret-pass-456"} {
		if err != nil && strings.Contains(err.Error(), secret) {
			t.Fatalf("错误文案泄漏凭据 %q: %q", secret, err.Error())
		}
	}
	if err == nil {
		t.Fatal("不同钥匙应当被阻断")
	}
}

// 22 端口的记录不覆盖同主机 2223 端口的连接（同一台机器、不同服务是不同身份）。
func TestPortRecordsDoNotLeakAcrossPorts(t *testing.T) {
	kh := NewKnownHosts("")
	serverKey, wire := testServerKey(t)
	if err := kh.Add("jump-a.example.com", 2223, serverKey.Type(), base64.StdEncoding.EncodeToString(wire)); err != nil {
		t.Fatalf("Add: %v", err)
	}

	if err := kh.HostKeyCallback("jump-a.example.com", 22)("jump-a.example.com", nil, serverKey); err == nil {
		t.Fatal("2223 端口的记录放行 22 端口连接了")
	}
	if err := kh.HostKeyCallback("jump-a.example.com", 2223)("jump-a.example.com", nil, serverKey); err != nil {
		t.Fatalf("2223 端口连接应当被自己的记录放行: %v", err)
	}
}

// 判据钉死：源码里不得再出现 InsecureIgnoreHostKey（grep 断言，非测试文件）。
func TestNoInsecureIgnoreHostKeyRemainsInSource(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("取不到当前文件位置")
	}
	dir := filepath.Dir(thisFile)
	matches, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil {
		t.Fatalf("Glob: %v", err)
	}
	if len(matches) == 0 {
		t.Fatal("一个 Go 文件都没找到，判据本身失效了")
	}
	for _, file := range matches {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("ReadFile(%s): %v", file, err)
		}
		if strings.Contains(string(raw), "InsecureIgnoreHostKey") {
			t.Fatalf("%s 里仍有 InsecureIgnoreHostKey 残留", file)
		}
	}
}

// NewTunnel 不允许没有校验器：hostKeys 为 nil 时 Start 必须失败，而不是静默放行。
func TestTunnelWithoutHostKeysRefusesToStart(t *testing.T) {
	tunnel := NewTunnel(hostKeyConfig("jump-a.example.com", 22), nil)
	tunnel.dialer = func(addr string, cfg *ssh.ClientConfig) (sshClientConn, error) {
		t.Fatal("没装校验器却拨号了")
		return &fakeClient{}, nil
	}
	if _, err := tunnel.Start(); err == nil {
		t.Fatal("没有 hostKeys 的隧道 Start 成功了，want 拒绝")
	}
}

func asHostKeyError(err error, target **HostKeyError) bool {
	for err != nil {
		if hke, ok := err.(*HostKeyError); ok {
			*target = hke
			return true
		}
		type unwrapper interface{ Unwrap() error }
		u, ok := err.(unwrapper)
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}
