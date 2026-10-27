package ssh

import (
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// Config describes an SSH tunnel and authentication settings.
type Config struct {
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Username   string `json:"username"`
	AuthType   string `json:"authType"`
	Password   string `json:"password,omitempty"`
	PrivateKey string `json:"privateKey,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
	LocalPort  int    `json:"localPort,omitempty"`
	RemotePort int    `json:"remotePort"`
	RemoteHost string `json:"remoteHost"`
}

// TestResult contains SSH login probe metadata.
type TestResult struct {
	LatencyMs int64 `json:"latencyMs"`
}

// sshClientConn 是隧道对 SSH 客户端的最小依赖面。
// *ssh.Client 天然满足它；单测靠它注入「拨号可以卡任意久」的假客户端 ——
// 退出路径不能被真实网络决定，所以这条缝必须是可替换的，而不是只有真机能验。
type sshClientConn interface {
	Dial(network, addr string) (net.Conn, error)
	Close() error
}

// sshDialFunc 建立 SSH 连接。拨号是可阻塞动作，必须留在临界区外（见 Start）。
type sshDialFunc func(addr string, cfg *ssh.ClientConfig) (sshClientConn, error)

// listenFunc 建立本地监听。同样是可阻塞动作，且单测要靠它造「Close 卡住」的监听器。
type listenFunc func(network, address string) (net.Listener, error)

// acceptRetryDelay 是 Accept 出错但隧道并未关闭时的退避，避免热转吃满一个核。
const acceptRetryDelay = 50 * time.Millisecond

// Tunnel is a running SSH tunnel instance.
type Tunnel struct {
	config    Config
	hostKeys  *KnownHosts
	dialer    sshDialFunc
	listenFn  listenFunc
	sshClient sshClientConn
	listener  net.Listener
	localPort int
	mu        sync.Mutex
	closed    bool
}

// NewTunnel 创建隧道。hostKeys 是主机密钥校验器，不可为 nil：
// 没有校验器的隧道在 Start 时会被拒绝，而不是静默放行（r104）。
func NewTunnel(config Config, hostKeys *KnownHosts) *Tunnel {
	return &Tunnel{
		config:   config,
		hostKeys: hostKeys,
		dialer: func(addr string, cfg *ssh.ClientConfig) (sshClientConn, error) {
			client, err := ssh.Dial("tcp", addr, cfg)
			if err != nil {
				return nil, err
			}
			return client, nil
		},
		listenFn: net.Listen,
	}
}

// Start 建立 SSH 连接并开始本地监听。
//
// 锁的用法是这一轮修的重点：拨号（含 TCP 之后的 SSH 握手）可以在任意时长上阻塞，
// 而 Stop() 拿的是同一把 t.mu。原先 Start 全程持锁 ⇒ 一条拨不动的隧道会把
// StopAll、进而把整个退出路径拖住：窗口没了、进程还在、exe 仍被系统当作镜像加载，
// Windows 安装程序只能永远停在「等待 ConfScope 退出」。
// 所以这里临界区只包「读 closed」和「提交结果」两步，拨号与监听都在锁外。
func (t *Tunnel) Start() (int, error) {
	t.mu.Lock()
	closed := t.closed
	t.mu.Unlock()
	if closed {
		return 0, fmt.Errorf("tunnel is closed")
	}

	sshConfig, err := t.createSSHConfig()
	if err != nil {
		return 0, fmt.Errorf("failed to create SSH config: %w", err)
	}

	addr := net.JoinHostPort(t.config.Host, strconv.Itoa(t.config.Port))
	sshClient, err := t.dialer(addr, sshConfig)
	if err != nil {
		return 0, fmt.Errorf("failed to connect to SSH server: %w", err)
	}

	localAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(t.config.LocalPort))
	listener, err := t.listenFn("tcp", localAddr)
	if err != nil {
		sshClient.Close()
		return 0, fmt.Errorf("failed to listen on local port: %w", err)
	}

	t.mu.Lock()
	if t.closed {
		// 拨号期间已经有人要求停止：当场收回，绝不留一条没人认领的监听。
		t.mu.Unlock()
		listener.Close()
		sshClient.Close()
		return 0, fmt.Errorf("tunnel is closed")
	}
	t.sshClient = sshClient
	t.listener = listener
	t.localPort = listener.Addr().(*net.TCPAddr).Port
	localPort := t.localPort
	t.mu.Unlock()

	go t.forward(listener, sshClient)

	return localPort, nil
}

// Stop 关闭隧道。置位与取快照在锁内，Close 在锁外。
//
// listener/client 的字段值不清空：转发协程还在按同一对象工作，
// 清空反而制造数据竞争。重复调用只会重复 Close（返回 error 被忽略）。
func (t *Tunnel) Stop() {
	t.mu.Lock()
	t.closed = true
	listener := t.listener
	client := t.sshClient
	t.mu.Unlock()

	if listener != nil {
		listener.Close()
	}
	if client != nil {
		client.Close()
	}
}

// GetLocalPort 返回本地监听端口；未建立时是 0。
// 加锁读是因为调用方（Manager 的复用判定）与 Start 的提交不在同一个 goroutine 上。
func (t *Tunnel) GetLocalPort() int {
	t.mu.Lock()
	defer t.mu.Unlock()

	return t.localPort
}

func (t *Tunnel) createSSHConfig() (*ssh.ClientConfig, error) {
	return createSSHConfig(t.config, t.hostKeys)
}

func createSSHConfig(config Config, hostKeys *KnownHosts) (*ssh.ClientConfig, error) {
	if hostKeys == nil {
		return nil, errors.New("SSH 主机密钥校验器未配置，拒绝建立未校验的隧道")
	}
	sshConfig := &ssh.ClientConfig{
		User:            config.Username,
		HostKeyCallback: hostKeys.HostKeyCallback(config.Host, config.Port),
		Timeout:         10 * time.Second,
	}

	switch config.AuthType {
	case "password":
		sshConfig.Auth = []ssh.AuthMethod{
			ssh.Password(config.Password),
		}
	case "key":
		signer, err := parsePrivateKey(config)
		if err != nil {
			return nil, fmt.Errorf("failed to parse private key: %w", err)
		}
		sshConfig.Auth = []ssh.AuthMethod{
			ssh.PublicKeys(signer),
		}
	default:
		return nil, fmt.Errorf("unsupported auth type: %s", config.AuthType)
	}

	return sshConfig, nil
}

func (t *Tunnel) parsePrivateKey() (ssh.Signer, error) {
	return parsePrivateKey(t.config)
}

func parsePrivateKey(config Config) (ssh.Signer, error) {
	var signer ssh.Signer
	var err error

	if config.Passphrase != "" {
		signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(config.PrivateKey), []byte(config.Passphrase))
	} else {
		signer, err = ssh.ParsePrivateKey([]byte(config.PrivateKey))
	}

	if err != nil {
		return nil, err
	}

	return signer, nil
}

// TestConnection verifies that the SSH server can be reached and authenticated.
func TestConnection(config Config, hostKeys *KnownHosts) (TestResult, error) {
	startedAt := time.Now()
	if config.Port <= 0 {
		config.Port = 22
	}

	sshConfig, err := createSSHConfig(config, hostKeys)
	if err != nil {
		return TestResult{LatencyMs: time.Since(startedAt).Milliseconds()}, fmt.Errorf("failed to create SSH config: %w", err)
	}

	addr := net.JoinHostPort(config.Host, strconv.Itoa(config.Port))
	client, err := ssh.Dial("tcp", addr, sshConfig)
	if err != nil {
		return TestResult{LatencyMs: time.Since(startedAt).Milliseconds()}, fmt.Errorf("failed to connect to SSH server: %w", err)
	}
	defer client.Close()

	return TestResult{LatencyMs: time.Since(startedAt).Milliseconds()}, nil
}

func (t *Tunnel) forward(listener net.Listener, client sshClientConn) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			t.mu.Lock()
			closed := t.closed
			t.mu.Unlock()
			if closed {
				return
			}
			// 没关闭却 Accept 失败是瞬时故障，退一步再看，别把 CPU 转满。
			time.Sleep(acceptRetryDelay)
			continue
		}

		go t.handleConnection(conn, client)
	}
}

func (t *Tunnel) handleConnection(localConn net.Conn, client sshClientConn) {
	defer localConn.Close()

	if client == nil {
		return
	}

	remoteAddr := net.JoinHostPort(t.config.RemoteHost, strconv.Itoa(t.config.RemotePort))
	remoteConn, err := client.Dial("tcp", remoteAddr)
	if err != nil {
		return
	}
	defer remoteConn.Close()

	done := make(chan struct{}, 2)

	go func() {
		io.Copy(localConn, remoteConn)
		done <- struct{}{}
	}()

	go func() {
		io.Copy(remoteConn, localConn)
		done <- struct{}{}
	}()

	<-done
}
