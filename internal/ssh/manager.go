// Package ssh 提供 SSH 隧道管理功能。
//
// 该包管理 SSH 隧道的生命周期，包括创建、启动和停止隧道。
package ssh

import (
	"fmt"
	"sync"
)

// Manager 管理多个 SSH 隧道实例。
type Manager struct {
	tunnels map[string]*Tunnel
	mu      sync.RWMutex
}

// NewManager 创建新的隧道管理器。
func NewManager() *Manager {
	return &Manager{
		tunnels: make(map[string]*Tunnel),
	}
}

// CreateTunnel 创建并启动 SSH 隧道。
// connectionId 是连接的唯一标识，config 是 SSH 隧道配置。
// 返回本地监听端口。
func (m *Manager) CreateTunnel(connectionId string, config Config) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	// 检查是否已存在隧道
	if existingTunnel, exists := m.tunnels[connectionId]; exists {
		// 如果已存在，先停止旧隧道
		existingTunnel.Stop()
		delete(m.tunnels, connectionId)
	}

	// 创建新隧道
	tunnel := NewTunnel(config)
	localPort, err := tunnel.Start()
	if err != nil {
		return 0, fmt.Errorf("failed to start tunnel for connection %s: %w", connectionId, err)
	}

	// 保存隧道实例
	m.tunnels[connectionId] = tunnel

	return localPort, nil
}

// StopTunnel 停止指定连接的 SSH 隧道。
func (m *Manager) StopTunnel(connectionId string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if tunnel, exists := m.tunnels[connectionId]; exists {
		tunnel.Stop()
		delete(m.tunnels, connectionId)
	}
}

// StopAll 停止所有 SSH 隧道。
func (m *Manager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for connectionId, tunnel := range m.tunnels {
		tunnel.Stop()
		delete(m.tunnels, connectionId)
	}
}

// GetTunnel 获取指定连接的隧道实例。
func (m *Manager) GetTunnel(connectionId string) *Tunnel {
	m.mu.RLock()
	defer m.mu.RUnlock()

	return m.tunnels[connectionId]
}

// GetLocalPort 获取指定连接的本地端口。
func (m *Manager) GetLocalPort(connectionId string) (int, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	tunnel, exists := m.tunnels[connectionId]
	if !exists {
		return 0, fmt.Errorf("no tunnel found for connection %s", connectionId)
	}

	return tunnel.GetLocalPort(), nil
}
