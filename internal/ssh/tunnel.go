package ssh

import (
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

// Tunnel is a running SSH tunnel instance.
type Tunnel struct {
	config    Config
	sshClient *ssh.Client
	listener  net.Listener
	localPort int
	mu        sync.Mutex
	closed    bool
}

func NewTunnel(config Config) *Tunnel {
	return &Tunnel{
		config: config,
	}
}

func (t *Tunnel) Start() (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.closed {
		return 0, fmt.Errorf("tunnel is closed")
	}

	sshConfig, err := t.createSSHConfig()
	if err != nil {
		return 0, fmt.Errorf("failed to create SSH config: %w", err)
	}

	addr := net.JoinHostPort(t.config.Host, strconv.Itoa(t.config.Port))
	sshClient, err := ssh.Dial("tcp", addr, sshConfig)
	if err != nil {
		return 0, fmt.Errorf("failed to connect to SSH server: %w", err)
	}
	t.sshClient = sshClient

	localAddr := net.JoinHostPort("localhost", strconv.Itoa(t.config.LocalPort))
	listener, err := net.Listen("tcp", localAddr)
	if err != nil {
		sshClient.Close()
		return 0, fmt.Errorf("failed to listen on local port: %w", err)
	}
	t.listener = listener
	t.localPort = listener.Addr().(*net.TCPAddr).Port

	go t.forward()

	return t.localPort, nil
}

func (t *Tunnel) Stop() {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.closed = true
	if t.listener != nil {
		t.listener.Close()
	}
	if t.sshClient != nil {
		t.sshClient.Close()
	}
}

func (t *Tunnel) GetLocalPort() int {
	return t.localPort
}

func (t *Tunnel) createSSHConfig() (*ssh.ClientConfig, error) {
	return createSSHConfig(t.config)
}

func createSSHConfig(config Config) (*ssh.ClientConfig, error) {
	sshConfig := &ssh.ClientConfig{
		User:            config.Username,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // TODO: verify host keys before production use.
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
func TestConnection(config Config) (TestResult, error) {
	startedAt := time.Now()
	if config.Port <= 0 {
		config.Port = 22
	}

	sshConfig, err := createSSHConfig(config)
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

func (t *Tunnel) forward() {
	for {
		conn, err := t.listener.Accept()
		if err != nil {
			t.mu.Lock()
			closed := t.closed
			t.mu.Unlock()
			if closed {
				return
			}
			continue
		}

		go t.handleConnection(conn)
	}
}

func (t *Tunnel) handleConnection(localConn net.Conn) {
	defer localConn.Close()

	remoteAddr := net.JoinHostPort(t.config.RemoteHost, strconv.Itoa(t.config.RemotePort))
	remoteConn, err := t.sshClient.Dial("tcp", remoteAddr)
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
