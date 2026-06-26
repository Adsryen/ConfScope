// Package ssh 实现 SSH 隧道连接功能。
//
// 支持通过 SSH 隧道访问内网的 Nacos 服务器，支持密码和密钥认证。
package ssh

import (
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"

	"golang.org/x/crypto/ssh"
)

// Config 是 SSH 隧道配置。
type Config struct {
	// SSH 服务器地址
	Host string `json:"host"`
	// SSH 端口，默认 22
	Port int `json:"port"`
	// SSH 用户名
	Username string `json:"username"`
	// 认证方式：password 或 key
	AuthType string `json:"authType"`
	// SSH 密码（password 认证时使用）
	Password string `json:"password,omitempty"`
	// SSH 私钥内容（key 认证时使用）
	PrivateKey string `json:"privateKey,omitempty"`
	// 私钥密码（如果有）
	Passphrase string `json:"passphrase,omitempty"`
	// 本地端口（可选，默认自动分配）
	LocalPort int `json:"localPort,omitempty"`
	// 远程端口（Nacos 服务器端口）
	RemotePort int `json:"remotePort"`
	// 远程主机（通常是 localhost 或 127.0.0.1）
	RemoteHost string `json:"remoteHost"`
}

// Tunnel 是 SSH 隧道实例。
type Tunnel struct {
	config    Config
	sshClient *ssh.Client
	listener  net.Listener
	localPort int
	mu        sync.Mutex
	closed    bool
}

// NewTunnel 创建新的 SSH 隧道实例。
func NewTunnel(config Config) *Tunnel {
	return &Tunnel{
		config: config,
	}
}

// Start 启动 SSH 隧道。
// 返回本地监听端口，如果配置中指定了本地端口则使用指定端口，否则自动分配。
func (t *Tunnel) Start() (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.closed {
		return 0, fmt.Errorf("tunnel is closed")
	}

	// 创建 SSH 客户端配置
	sshConfig, err := t.createSSHConfig()
	if err != nil {
		return 0, fmt.Errorf("failed to create SSH config: %w", err)
	}

	// 连接 SSH 服务器
	addr := net.JoinHostPort(t.config.Host, strconv.Itoa(t.config.Port))
	sshClient, err := ssh.Dial("tcp", addr, sshConfig)
	if err != nil {
		return 0, fmt.Errorf("failed to connect to SSH server: %w", err)
	}
	t.sshClient = sshClient

	// 创建本地监听器
	localAddr := net.JoinHostPort("localhost", strconv.Itoa(t.config.LocalPort))
	listener, err := net.Listen("tcp", localAddr)
	if err != nil {
		sshClient.Close()
		return 0, fmt.Errorf("failed to listen on local port: %w", err)
	}
	t.listener = listener

	// 获取实际监听端口
	t.localPort = listener.Addr().(*net.TCPAddr).Port

	// 启动转发协程
	go t.forward()

	return t.localPort, nil
}

// Stop 停止 SSH 隧道。
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

// GetLocalPort 获取本地监听端口。
func (t *Tunnel) GetLocalPort() int {
	return t.localPort
}

// createSSHConfig 创建 SSH 客户端配置。
func (t *Tunnel) createSSHConfig() (*ssh.ClientConfig, error) {
	config := &ssh.ClientConfig{
		User:            t.config.Username,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // TODO: 生产环境应该验证主机密钥
	}

	switch t.config.AuthType {
	case "password":
		config.Auth = []ssh.AuthMethod{
			ssh.Password(t.config.Password),
		}
	case "key":
		signer, err := t.parsePrivateKey()
		if err != nil {
			return nil, fmt.Errorf("failed to parse private key: %w", err)
		}
		config.Auth = []ssh.AuthMethod{
			ssh.PublicKeys(signer),
		}
	default:
		return nil, fmt.Errorf("unsupported auth type: %s", t.config.AuthType)
	}

	return config, nil
}

// parsePrivateKey 解析私钥。
func (t *Tunnel) parsePrivateKey() (ssh.Signer, error) {
	var signer ssh.Signer
	var err error

	if t.config.Passphrase != "" {
		signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(t.config.PrivateKey), []byte(t.config.Passphrase))
	} else {
		signer, err = ssh.ParsePrivateKey([]byte(t.config.PrivateKey))
	}

	if err != nil {
		return nil, err
	}

	return signer, nil
}

// forward 执行端口转发。
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

// handleConnection 处理单个连接。
func (t *Tunnel) handleConnection(localConn net.Conn) {
	defer localConn.Close()

	// 连接远程服务
	remoteAddr := net.JoinHostPort(t.config.RemoteHost, strconv.Itoa(t.config.RemotePort))
	remoteConn, err := t.sshClient.Dial("tcp", remoteAddr)
	if err != nil {
		return
	}
	defer remoteConn.Close()

	// 双向复制数据
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
