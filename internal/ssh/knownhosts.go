package ssh

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"golang.org/x/crypto/ssh"
)

// HostKeyVerdict 是一次主机密钥裁决的结论。
// 两个「未通过」的取值同时是前端要识别的错误标识：未知主机走「确认指纹」，
// 指纹变更走硬阻断（不提供「仍然连接」）。
type HostKeyVerdict string

const (
	// HostKeyTrusted 服务端出示的钥匙与 known_hosts 记录一致。
	HostKeyTrusted HostKeyVerdict = "trusted"
	// HostKeyUnknown 该主机在 known_hosts 里没有记录，需要用户首次确认指纹。
	HostKeyUnknown HostKeyVerdict = "hostKeyUnknown"
	// HostKeyChanged 有记录但和服务端现在出示的钥匙对不上，按中间人风险阻断。
	HostKeyChanged HostKeyVerdict = "hostKeyChanged"
	// HostKeyMismatch 握手身份与拨号目标对不上（客户端侧异常，非服务端换钥匙）：
	// 删记录解决不了，按阻断处理，文案不得引导用户去删记录。
	HostKeyMismatch HostKeyVerdict = "hostKeyMismatch"
)

// HostKeyError 是主机密钥裁决未通过时抛出的错误。
// 文案与字段只含主机名、端口、算法与指纹——凭据一个字都不进（r104 R5）。
type HostKeyError struct {
	Verdict           HostKeyVerdict
	Host              string
	Port              int
	RecordID          string
	Hostname          string
	KeyType           string
	Fingerprint       string
	RecordFingerprint string
	Path              string
}

func (e *HostKeyError) Error() string {
	switch e.Verdict {
	case HostKeyUnknown:
		return fmt.Sprintf(
			"SSH 主机密钥未信任：%s 出示了 %s 钥匙（指纹 %s），known_hosts 里没有这条记录。"+
				"请先确认这把钥匙确实属于该跳板机再建立连接（记录文件：%s）",
			e.RecordID, e.KeyType, e.Fingerprint, e.Path,
		)
	case HostKeyChanged:
		return fmt.Sprintf(
			"SSH 主机密钥已变更：%s 记录的指纹是 %s，服务端现在出示的是 %s（指纹 %s）。"+
				"连接可能被中间人替换，已阻断。确认安全后，请手动删除 %s 中 %s 的记录再重连（本工具不会自动删除）",
			e.RecordID, e.RecordFingerprint, e.KeyType, e.Fingerprint, e.Path, e.RecordID,
		)
	case HostKeyMismatch:
		return fmt.Sprintf(
			"SSH 主机密钥身份不符：握手时收到的主机名 %q 与拨号目标 %s 不一致（出示 %s，指纹 %s）。"+
				"这与「该主机更换了钥匙」不同，手动删除记录解决不了，连接已阻断。请确认连接配置未被改动后重试",
			e.Hostname, e.RecordID, e.KeyType, e.Fingerprint,
		)
	}
	return "SSH 主机密钥校验未通过"
}

// HostKeyStatus 是探测接口返回的主机密钥裁决结果（不建隧道、不完成认证）。
type HostKeyStatus struct {
	Status            HostKeyVerdict `json:"status"`
	Host              string         `json:"host"`
	Port              int            `json:"port"`
	RecordID          string         `json:"recordId"`
	KeyType           string         `json:"keyType,omitempty"`
	KeyBase64         string         `json:"keyBase64,omitempty"`
	Fingerprint       string         `json:"fingerprint,omitempty"`
	RecordFingerprint string         `json:"recordFingerprint,omitempty"`
	KnownHostsPath    string         `json:"knownHostsPath"`
}

// knownHostsLine 是 known_hosts 里一条可参与裁决的记录。
// raw 保留原文：重写文件时原样回写，不破坏用户手工加过注释的行。
type knownHostsLine struct {
	raw     string
	hosts   []string
	keyType string
	keyB64  string
	key     []byte
}

// KnownHosts 是一份 known_hosts 存储，沿用 OpenSSH 的行格式：
//
//	[标记...] 主机模式列表 算法 base64公钥 [注释]
//
// 主机模式支持 OpenSSH 的写法：裸主机（匹配任意端口）、host:port / [ip]:port
// （只匹配该端口）、*.域名 与 .域名 后缀通配、*。
//
// 裁决语义：服务端出示的钥匙与任一匹配记录相等即放行；一条记录都没有 →
// hostKeyUnknown；有记录但都不相等 → hostKeyChanged。两条硬阻断都不给旁路。
//
// 文件即事实源：每次裁决都在锁内重新读盘（与 OpenSSH 每次连接都重读一致，
// 用户在两次连接之间手改文件立即生效）。文件很小，重读成本可忽略。
// path 为空是纯内存模式（只给单测用）：记录只存在内存里。
type KnownHosts struct {
	mu    sync.Mutex
	path  string
	lines []knownHostsLine
}

// NewKnownHosts 创建 known_hosts 存储。
// path 为空表示纯内存模式（只给单测用）：不读不写任何文件。
func NewKnownHosts(path string) *KnownHosts {
	return &KnownHosts{path: path}
}

// Path 返回记录文件位置；内存模式返回空串。
func (k *KnownHosts) Path() string {
	return k.path
}

// recordID 是 (host, port) 在 known_hosts 里的身份写法：
// 22 端口写裸主机（与 OpenSSH 习惯一致）；非 22 端口写 host:port，
// IP 字面量按 OpenSSH 的写法加方括号。
func recordID(host string, port int) string {
	if port <= 0 || port == 22 {
		return host
	}
	if net.ParseIP(host) != nil {
		return fmt.Sprintf("[%s]:%d", host, port)
	}
	return fmt.Sprintf("%s:%d", host, port)
}

// fingerprintOf 返回 OpenSSH 形式的 SHA256 指纹：SHA256: + 无填充 base64。
func fingerprintOf(rawKey []byte) string {
	sum := sha256.Sum256(rawKey)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

// normalizePort 把 0/非法端口归一到 22（与 Config 里既有约定一致）。
func normalizePort(port int) int {
	if port <= 0 {
		return 22
	}
	return port
}

// HostKeyCallback 返回绑定到 (host, port) 的 SSH 主机密钥回调，
// 供 ssh.ClientConfig.HostKeyCallback 在握手第一步使用。
func (k *KnownHosts) HostKeyCallback(host string, port int) ssh.HostKeyCallback {
	port = normalizePort(port)
	return func(hostname string, _ net.Addr, key ssh.PublicKey) error {
		k.mu.Lock()
		defer k.mu.Unlock()

		// x/crypto 交给回调的是拨号地址（dialAddress）：tunnel.go 用 net.JoinHostPort
		// 从 (host, port) 拼出来，带端口（golang.org/x/crypto/ssh/handshake.go 原样传入）。
		// 比对身份前先剥掉端口归一；裸 IPv6（无端口分隔）走 SplitHostPort 的
		// err 分支保持原值。2026-10-27 复检复现：不归一时所有已信任主机在
		// 真实拨号时都被误判成「密钥变更」硬阻断。
		if h, _, err := net.SplitHostPort(hostname); err == nil {
			hostname = h
		}
		if hostname != host {
			return &HostKeyError{
				Verdict:     HostKeyMismatch,
				Hostname:    hostname,
				Host:        host,
				Port:        port,
				RecordID:    recordID(host, port),
				KeyType:     key.Type(),
				Fingerprint: fingerprintOf(key.Marshal()),
			}
		}
		entries := k.lookupLocked(host, port)
		if len(entries) == 0 {
			return &HostKeyError{
				Verdict:     HostKeyUnknown,
				Host:        host,
				Port:        port,
				RecordID:    recordID(host, port),
				KeyType:     key.Type(),
				Fingerprint: fingerprintOf(key.Marshal()),
				Path:        k.path,
			}
		}
		wire := key.Marshal()
		for _, entry := range entries {
			if bytes.Equal(entry.key, wire) {
				return nil
			}
		}
		return &HostKeyError{
			Verdict:           HostKeyChanged,
			Host:              host,
			Port:              port,
			RecordID:          recordID(host, port),
			KeyType:           key.Type(),
			Fingerprint:       fingerprintOf(wire),
			RecordFingerprint: fingerprintOf(entries[0].key),
			Path:              k.path,
		}
	}
}

// Judge 对一把出示的钥匙做裁决（ProbeHostKey 用它，把结果交给界面展示）。
func (k *KnownHosts) Judge(host string, port int, key ssh.PublicKey) HostKeyStatus {
	port = normalizePort(port)
	k.mu.Lock()
	defer k.mu.Unlock()

	wire := key.Marshal()
	status := HostKeyStatus{
		Host:           host,
		Port:           port,
		RecordID:       recordID(host, port),
		KeyType:        key.Type(),
		KeyBase64:      base64.StdEncoding.EncodeToString(wire),
		Fingerprint:    fingerprintOf(wire),
		KnownHostsPath: k.path,
	}
	entries := k.lookupLocked(host, port)
	switch {
	case len(entries) == 0:
		status.Status = HostKeyUnknown
	case keyMatchesAny(entries, wire):
		status.Status = HostKeyTrusted
	default:
		status.Status = HostKeyChanged
		status.RecordFingerprint = fingerprintOf(entries[0].key)
	}
	return status
}

func keyMatchesAny(entries []knownHostsLine, wire []byte) bool {
	for _, entry := range entries {
		if bytes.Equal(entry.key, wire) {
			return true
		}
	}
	return false
}

// validRecordHost 判断 host 是否是 Add 可写入的精确身份：
// 主机名（字母数字与 . - _，单标签 ≤63、总长 ≤253）或 net.ParseIP
// 认得的 IP 字面量（含 IPv6）。空白与任何控制字符、, * ? # [ ] 等
// OpenSSH 特殊字符及其余取值一律拒绝——它们正是把记录变成通配、
// 主机列表或注入完整第二行的手段。
func validRecordHost(host string) bool {
	if host == "" {
		return false
	}
	for _, r := range host {
		if r < 0x20 || r == 0x7f || unicode.IsSpace(r) {
			return false
		}
	}
	if net.ParseIP(host) != nil {
		return true
	}
	if len(host) > 253 {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 {
			return false
		}
		for _, r := range label {
			switch {
			case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			case r == '-' || r == '_':
			default:
				return false
			}
		}
	}
	return true
}

// Add 校验并写入一把用户确认过的钥匙。
//
// 身份纪律：只接受精确身份（主机名或 IP 字面量，见 validRecordHost），
// 端口显式 1..65535。*、*.域名 这类通配、逗号主机列表与换行注入一律拒绝——
// 通配记录会让同一把钥匙在所有主机上放行，换行能注入一条完整的新记录；
// 文件内容里用户手写的通配仍由 lookup 按 OpenSSH 并集语义裁决，本入口不收。
//
// 钥匙纪律：同一个 (host, port) 记录已有不同钥匙时拒绝追加——
// 「旧记录 + 新钥匙」并存等于给指纹变更开了并集旁路。
// 同一把钥匙重复信任是幂等的。
func (k *KnownHosts) Add(host string, port int, keyType, keyB64 string) error {
	if !validRecordHost(host) {
		return fmt.Errorf(
			"主机 %q 不能写入 known_hosts：只接受精确的主机名或 IP（通配、主机列表与特殊字符一律拒绝）",
			host,
		)
	}
	if port < 1 || port > 65535 {
		return fmt.Errorf("端口 %d 超出范围：只接受 1..65535", port)
	}

	raw, err := base64.StdEncoding.DecodeString(keyB64)
	if err != nil {
		return fmt.Errorf("主机密钥不是合法的 base64: %w", err)
	}
	publicKey, err := ssh.ParsePublicKey(raw)
	if err != nil {
		return fmt.Errorf("主机密钥不是可解析的公钥: %w", err)
	}
	if keyType != "" && publicKey.Type() != keyType {
		return fmt.Errorf("主机密钥算法 %s 与声明的 %s 不一致", publicKey.Type(), keyType)
	}

	id := recordID(host, port)
	line := knownHostsLine{
		hosts:   []string{id},
		keyType: publicKey.Type(),
		keyB64:  keyB64,
		key:     raw,
	}

	k.mu.Lock()
	defer k.mu.Unlock()

	for _, existing := range k.snapshotLocked() {
		for _, pattern := range existing.hosts {
			if !isExactHostPortPattern(pattern, host, port) {
				continue
			}
			if bytes.Equal(existing.key, raw) {
				return nil // 幂等
			}
			return fmt.Errorf(
				"known_hosts 里 %s 已记录了另一把钥匙（指纹 %s）；请先手动删除该记录，再决定是否信任新钥匙",
				id, fingerprintOf(existing.key),
			)
		}
	}

	line.raw = fmt.Sprintf("%s %s %s", id, publicKey.Type(), keyB64)
	if k.path == "" {
		k.lines = append(k.lines, line)
		return nil
	}
	return k.writeAllLocked(append(k.snapshotLocked(), line))
}

// lookup 返回所有主机模式匹配 (host, port) 的记录。
func (k *KnownHosts) lookup(host string, port int) []knownHostsLine {
	port = normalizePort(port)
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.lookupLocked(host, port)
}

func (k *KnownHosts) lookupLocked(host string, port int) []knownHostsLine {
	var out []knownHostsLine
	for _, line := range k.snapshotLocked() {
		for _, pattern := range line.hosts {
			if hostPatternMatches(pattern, host, port) {
				out = append(out, line)
				break
			}
		}
	}
	return out
}

// snapshotLocked 返回当前全部有效记录。文件模式每次重读（文件即事实源）；
// 内存模式直接返回内存里的行。
func (k *KnownHosts) snapshotLocked() []knownHostsLine {
	if k.path == "" {
		return k.lines
	}
	return readKnownHostsFile(k.path)
}

// readKnownHostsFile 读盘解析。文件不存在视为空记录；读不出的行跳过
// （跳过只会让裁决更保守——记录少了顶多是「未信任」，不会误放行）。
func readKnownHostsFile(path string) []knownHostsLine {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []knownHostsLine
	for _, line := range strings.Split(string(raw), "\n") {
		trimmed := strings.TrimSpace(strings.TrimRight(line, "\r"))
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "@") {
			// @revoked / @cert-authority 等标记行不进入可信池：
			// 被撤销的钥匙绝不应被信任，证书链不在本工具范围。
			continue
		}
		if parsed, ok := parseKnownHostsLine(trimmed); ok {
			out = append(out, parsed)
		}
	}
	return out
}

// writeAllLocked 原子落盘：临时文件 + rename，避免半截文件。
func (k *KnownHosts) writeAllLocked(lines []knownHostsLine) error {
	var buf strings.Builder
	for _, line := range lines {
		buf.WriteString(line.raw)
		buf.WriteByte('\n')
	}
	if err := os.MkdirAll(filepath.Dir(k.path), 0o755); err != nil {
		return fmt.Errorf("创建 known_hosts 目录: %w", err)
	}
	tmp := fmt.Sprintf("%s.tmp-%d", k.path, time.Now().UnixNano())
	if err := os.WriteFile(tmp, []byte(buf.String()), 0o644); err != nil {
		return fmt.Errorf("写入 known_hosts 临时文件: %w", err)
	}
	if err := os.Rename(tmp, k.path); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("替换 known_hosts: %w", err)
	}
	return nil
}

// parseKnownHostsLine 解析一行 OpenSSH known_hosts 内容：
//
//	主机模式列表 算法 base64公钥 [注释]
//
// 标记行（@ 开头）由调用方先行过滤。解析不出三要素返回 ok=false。
func parseKnownHostsLine(line string) (knownHostsLine, bool) {
	fields := strings.Fields(line)
	if len(fields) < 3 {
		return knownHostsLine{}, false
	}
	hostList, keyType, keyB64 := fields[0], fields[1], fields[2]

	raw, err := base64.StdEncoding.DecodeString(keyB64)
	if err != nil || len(raw) == 0 {
		return knownHostsLine{}, false
	}
	if !isPlausibleKeyType(keyType) {
		return knownHostsLine{}, false
	}

	return knownHostsLine{
		raw:     line,
		hosts:   strings.Split(hostList, ","),
		keyType: keyType,
		keyB64:  keyB64,
		key:     raw,
	}, true
}

// isPlausibleKeyType 宽松校验算法字段：字母数字加 '-' 与 '@'（sk-xxx@openssh.com 一类）。
func isPlausibleKeyType(keyType string) bool {
	if keyType == "" {
		return false
	}
	for _, r := range keyType {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-' || r == '@':
		default:
			return false
		}
	}
	return true
}

// isExactHostPortPattern 判断一个主机模式是否恰好钉住 (host, port) 这一身份
// （Add 的「同记录只认一把钥匙」判定用）。
func isExactHostPortPattern(pattern, host string, port int) bool {
	h, p, pinned := splitHostPortPattern(pattern)
	if pinned {
		return h == host && p == port
	}
	return port == 22 && h == host
}

// splitHostPortPattern 把主机模式拆成 (host, port, 是否钉了端口)。
// 支持 [ip]:port 与 host:port 两种钉法；其余一律是「任意端口」模式。
func splitHostPortPattern(pattern string) (host string, port int, pinned bool) {
	if strings.HasPrefix(pattern, "[") {
		end := strings.Index(pattern, "]")
		if end < 0 {
			return pattern, 0, false
		}
		rest := pattern[end+1:]
		if !strings.HasPrefix(rest, ":") {
			return pattern, 0, false
		}
		parsed, err := strconv.Atoi(strings.TrimPrefix(rest, ":"))
		if err != nil {
			return pattern, 0, false
		}
		return pattern[1:end], parsed, true
	}
	idx := strings.LastIndex(pattern, ":")
	if idx < 0 {
		return pattern, 0, false
	}
	parsed, err := strconv.Atoi(pattern[idx+1:])
	if err != nil {
		return pattern, 0, false
	}
	return pattern[:idx], parsed, true
}

// hostPatternMatches 判断一个主机模式是否覆盖 (host, port)。
// 钉了端口的模式只认那个端口；裸模式按 OpenSSH 的通配规则匹配任意端口。
func hostPatternMatches(pattern, host string, port int) bool {
	pattern = strings.TrimSpace(pattern)
	h, p, pinned := splitHostPortPattern(pattern)
	if pinned {
		if !hostNameMatches(h, host) {
			return false
		}
		return p == port
	}
	return hostNameMatches(pattern, host)
}

// hostNameMatches 实现 OpenSSH 的主机通配：*、.后缀、*.后缀 与精确匹配。
func hostNameMatches(pattern, host string) bool {
	if pattern == "" {
		return false
	}
	if pattern == "*" {
		return true
	}
	if strings.HasPrefix(pattern, "*.") {
		return strings.HasSuffix(host, pattern[1:])
	}
	if strings.HasPrefix(pattern, ".") {
		return strings.HasSuffix(host, pattern)
	}
	return pattern == host
}
