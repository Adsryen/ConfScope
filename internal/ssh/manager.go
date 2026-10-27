// Package ssh 提供 SSH 隧道管理功能。
//
// 该包管理 SSH 隧道的生命周期，包括创建、启动和停止隧道。
package ssh

import (
	"errors"
	"fmt"
	"net"
	"sort"
	"strconv"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// 提交结果（createTunnel 与 commit 之间的约定）。
const (
	commitOK      = iota // 这一格换成了我刚建好的隧道
	commitStopped        // 拨号期间这条连接被要求停止过，我刚建好的必须收回
	commitReused         // 拨号期间别人已建好同配置的可用隧道，以那条为准
)

// Manager 管理多个 SSH 隧道实例。
//
// 锁纪律：m.mu 只保护两张表，绝不跨越
// dial / Close 这类可阻塞动作。khMu 只保护「当前数据根对应的校验器实例」
// 这一对内存字段，同样不跨可阻塞动作。
type Manager struct {
	tunnels map[string]*Tunnel
	// newTunnel 是创建隧道的接缝：默认 NewTunnel，单测换成「拨号可以被外界控制」的假隧道。
	// 没有这条缝，退出路径上的并发与超时行为就只能靠真网络去撞 —— 那等于没验证过。
	newTunnel func(Config, *KnownHosts) *Tunnel
	// knownHostsPath 由宿主（桌面端）给出：known_hosts 落在当前数据根下。
	// 用解析函数而不是固定字符串，是因为数据根可以整体搬家（换根迁移），
	// 搬家之后下一次连接必须自动落到新位置。
	knownHostsPath func() string
	// khMu 保护 kh：解析路径、按需换实例这一小步。
	khMu sync.Mutex
	// kh 是当前数据根对应的 known_hosts 实例；路径变了就重建（见 knownHosts）。
	kh *KnownHosts
	// stopEpoch 是每条连接的「这一格的隧道作废」计数：手动停止、换配置重建、
	// StopAll 都让它自增。创建动作在拨号前记下自己看到的值，提交时比对 ——
	// 否则会出现「用户点了停止，隧道却在你拨号完成之后悄悄复活」。
	stopEpoch map[string]uint64
	// stopping 只在「带硬上限的收尾」那一次置位，也就是退出路径：
	// 此后不再接受新的隧道提交，否则一条正在拨的隧道会在进程收尾时复活成新的占用者。
	// 用户主动点的「关闭全部隧道」不走这里（StopAll 的上限是 0），关掉之后还要能再开。
	stopping bool
	mu       sync.RWMutex
}

// NewManager 创建新的隧道管理器。
// knownHostsPath 返回 known_hosts 文件位置（当前数据根下）；
// 返回空串视为未配置，任何需要主机密钥裁决的动作都会失败，而不是跳过校验。
func NewManager(knownHostsPath func() string) *Manager {
	return &Manager{
		tunnels:        make(map[string]*Tunnel),
		stopEpoch:      make(map[string]uint64),
		knownHostsPath: knownHostsPath,
		newTunnel:      func(config Config, hostKeys *KnownHosts) *Tunnel { return NewTunnel(config, hostKeys) },
	}
}

// knownHosts 取当前数据根对应的 known_hosts 实例；路径变了（换根迁移）就重建。
func (m *Manager) knownHosts() (*KnownHosts, error) {
	m.khMu.Lock()
	defer m.khMu.Unlock()

	path := ""
	if m.knownHostsPath != nil {
		path = m.knownHostsPath()
	}
	if path == "" {
		return nil, errors.New("SSH 主机密钥校验不可用：数据目录未能解析，拒绝建立未校验的隧道")
	}
	if m.kh == nil || m.kh.Path() != path {
		m.kh = NewKnownHosts(path)
	}
	return m.kh, nil
}

// KnownHosts 返回本管理器的主机密钥存储（探测与信任接口共用同一份）。
func (m *Manager) KnownHosts() (*KnownHosts, error) {
	return m.knownHosts()
}

// TrustHostKey 把用户确认过的主机密钥写进 known_hosts（r104 R2 的落盘一步）。
func (m *Manager) TrustHostKey(host string, port int, keyType, keyBase64 string) error {
	hostKeys, err := m.knownHosts()
	if err != nil {
		return err
	}
	return hostKeys.Add(host, port, keyType, keyBase64)
}

// ProbeHostKey 拨一次 SSH 服务器，取回它出示的主机密钥并裁决
// （不完成认证、不建隧道）：结果交给界面决定弹确认还是直接阻断。
func (m *Manager) ProbeHostKey(config Config) (HostKeyStatus, error) {
	if config.Host == "" {
		return HostKeyStatus{}, errors.New("SSH 主机名不能为空")
	}
	hostKeys, err := m.knownHosts()
	if err != nil {
		return HostKeyStatus{}, err
	}
	if config.Port <= 0 {
		config.Port = 22
	}

	// 探测阶段只取回出示的钥匙，裁决在 Judge 里做：
	// 裁决依据与真正建连用的是同一份 known_hosts，口径不会分叉。
	//
	// x/crypto 没有「只握手不认证」的公开入口（NewClientConn 也会走到认证）。
	// 所以探测不带任何认证方法：客户端内置的 "none" 尝试会被服务器拒掉，
	// 但拒绝发生在主机密钥交换「之后」——回调抓到钥匙即说明握手完成，
	// 这次 auth 失败是探测的预期结果，不代表握手有问题。
	var presented ssh.PublicKey
	sshConfig := &ssh.ClientConfig{
		User: config.Username,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			presented = key
			return nil
		},
		Timeout: 10 * time.Second,
	}

	addr := net.JoinHostPort(config.Host, strconv.Itoa(config.Port))
	client, err := ssh.Dial("tcp", addr, sshConfig)
	if client != nil {
		_ = client.Close()
	}

	if presented == nil {
		if err != nil {
			return HostKeyStatus{}, fmt.Errorf("无法连接 SSH 服务器 %s: %w", addr, err)
		}
		return HostKeyStatus{}, fmt.Errorf("SSH 服务器 %s 没有出示主机密钥", addr)
	}
	return hostKeys.Judge(config.Host, config.Port, presented), nil
}

// CreateTunnel 创建并启动 SSH 隧道。
// connectionId 是连接的唯一标识，config 是 SSH 隧道配置。
// 返回本地监听端口。
func (m *Manager) CreateTunnel(connectionId string, config Config) (int, error) {
	existingTunnel, _ := m.inspect(connectionId)

	// 同一连接的并发请求可能同时要求创建隧道。
	// 如果配置没有变化且端口已经起来了，直接复用，避免后一个请求把前一个请求刚拿到的端口关闭。
	if existingTunnel != nil && existingTunnel.config == config {
		if port := existingTunnel.GetLocalPort(); port > 0 {
			return port, nil
		}
	}

	// 要换一条：旧的在锁外停。Stop 不再阻塞在别人的拨号上，但它仍是可阻塞动作，
	// 不该让整张表陪着等。
	if existingTunnel != nil {
		existingTunnel.Stop()
		m.forget(connectionId, existingTunnel)
	}

	// epoch 必须在拨号之前取：上面那次 forget 是我们自己发起的重建，不该作废接下来这一步。
	_, epoch := m.inspect(connectionId)

	// 校验器在拨号前就位：主机密钥裁决是握手的一部分，缺了它就不许拨号。
	hostKeys, err := m.knownHosts()
	if err != nil {
		return 0, fmt.Errorf("failed to start tunnel for connection %s: %w", connectionId, err)
	}

	// 拨号在锁外：目标跳板机不可达时这里可以阻塞很久，
	// 期间用户仍然能停止别的隧道、能查活动连接列表、能让程序退出。
	tunnel := m.newTunnel(config, hostKeys)
	localPort, dialErr := tunnel.Start()
	if dialErr != nil {
		return 0, fmt.Errorf("failed to start tunnel for connection %s: %w", connectionId, dialErr)
	}

	outcome, reusedPort, stale := m.commit(connectionId, tunnel, config, epoch)
	// 这一格里原来那条已经废了（配置不同或端口没起来）：锁外停掉它。
	if stale != nil {
		stale.Stop()
	}

	switch outcome {
	case commitStopped:
		tunnel.Stop()
		return 0, fmt.Errorf("failed to start tunnel for connection %s: tunnel was stopped while connecting", connectionId)
	case commitReused:
		// 先建好的那条活着，这条是重复劳动的产物，收回。
		tunnel.Stop()
		return reusedPort, nil
	default:
		return localPort, nil
	}
}

// StopTunnel 停止指定连接的 SSH 隧道。
func (m *Manager) StopTunnel(connectionId string) {
	tunnel := m.take(connectionId)
	if tunnel != nil {
		tunnel.Stop()
	}
}

// StopAll 停止所有 SSH 隧道（不设上限）。
func (m *Manager) StopAll() {
	m.StopAllWithCeiling(0)
}

// StopAllWithCeiling 停止所有隧道，并给整个动作设一个硬上限（ceiling <= 0 表示不设上限）。
// 返回上限之内没能停下来的连接标识，供退出路径点名写进日志。
//
// 上限存在的理由很具体：Windows 安装程序在覆盖二进制之前要确认目标 exe 不再被占用，
// 而「窗口已经没了、进程却退不出去」等于文件永远被系统映射着，
// 用户只能卡在「等待 ConfScope 退出」。一条拨不动的隧道不该拿走整个程序的退出能力。
func (m *Manager) StopAllWithCeiling(ceiling time.Duration) []string {
	m.mu.Lock()
	ids := make([]string, 0, len(m.tunnels))
	tunnels := make([]*Tunnel, 0, len(m.tunnels))
	for connectionId, tunnel := range m.tunnels {
		ids = append(ids, connectionId)
		tunnels = append(tunnels, tunnel)
		delete(m.tunnels, connectionId)
		m.stopEpoch[connectionId]++
	}
	m.mu.Unlock()
	// 表在这里就清空了：ActiveConnectionIDs 立刻变空，正是升级交接
	// 轮询「都关了吗」所需要的语义。

	if ceiling <= 0 {
		for _, tunnel := range tunnels {
			tunnel.Stop()
		}
		return nil
	}

	m.markStopping()

	// 各条隧道并行关，谁没关完不等谁。channel 容量按条数给足，
	// 超时后迟到的那几条不会把 goroutine 卡在发送上。
	stopped := make(chan string, len(ids))
	for index, tunnel := range tunnels {
		go func(connectionId string, tunnel *Tunnel) {
			tunnel.Stop()
			stopped <- connectionId
		}(ids[index], tunnel)
	}

	done := make(map[string]bool, len(ids))
	deadline := time.After(ceiling)
	for len(done) < len(ids) {
		select {
		case connectionId := <-stopped:
			done[connectionId] = true
		case <-deadline:
			pending := make([]string, 0, len(ids)-len(done))
			for _, connectionId := range ids {
				if !done[connectionId] {
					pending = append(pending, connectionId)
				}
			}
			sort.Strings(pending)
			return pending
		}
	}
	return nil
}

// ActiveConnectionIDs 返回当前有隧道的连接标识（按字典序，界面要稳定可比对）。
// 升级交接前的忙碌闸门靠它判断"退出会不会掐断正在浏览的隧道"。
func (m *Manager) ActiveConnectionIDs() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	ids := make([]string, 0, len(m.tunnels))
	for id := range m.tunnels {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// GetTunnel 获取指定连接的隧道实例。
func (m *Manager) GetTunnel(connectionId string) *Tunnel {
	m.mu.RLock()
	defer m.mu.RUnlock()

	return m.tunnels[connectionId]
}

// GetLocalPort 获取指定连接的本地端口。
func (m *Manager) GetLocalPort(connectionId string) (int, error) {
	tunnel := m.GetTunnel(connectionId)
	if tunnel == nil {
		return 0, fmt.Errorf("no tunnel found for connection %s", connectionId)
	}

	return tunnel.GetLocalPort(), nil
}

// markStopping 标记「程序正在收尾」，此后 commit 一律失败。
func (m *Manager) markStopping() {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.stopping = true
}

// inspect 同时读出这一格的隧道与作废计数，供创建前后两次对照。
func (m *Manager) inspect(connectionId string) (*Tunnel, uint64) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	return m.tunnels[connectionId], m.stopEpoch[connectionId]
}

// take 摘走这一格的隧道并让作废计数自增（停止请求的落点）。
func (m *Manager) take(connectionId string) *Tunnel {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.stopEpoch[connectionId]++
	tunnel := m.tunnels[connectionId]
	delete(m.tunnels, connectionId)
	return tunnel
}

// forget 只在 map 里仍然是这一条时摘除：并发创建时不许删别人刚提交的隧道。
func (m *Manager) forget(connectionId string, tunnel *Tunnel) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if current, exists := m.tunnels[connectionId]; exists && current == tunnel {
		delete(m.tunnels, connectionId)
		m.stopEpoch[connectionId]++
	}
}

// commit 在锁内决定这一格最终归谁。只读 map 与端口（都是内存操作），不碰网络。
// 返回的 stale 是「被换掉的那条」，调用方必须在锁外停它。
func (m *Manager) commit(connectionId string, tunnel *Tunnel, config Config, epoch uint64) (outcome int, reusedPort int, stale *Tunnel) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.stopping || m.stopEpoch[connectionId] != epoch {
		// stopping：程序正在收尾，这条隧道没有归属者了。
		// epoch 变了：期间有人对这条连接点过停止/重建，刚拨好的必须自己收回去。
		return commitStopped, 0, nil
	}

	if current, exists := m.tunnels[connectionId]; exists && current != tunnel {
		if port := current.GetLocalPort(); current.config == config && port > 0 {
			// 拨号期间同连接已经建好一条能用的：以先建者为准。
			return commitReused, port, nil
		}
		m.tunnels[connectionId] = tunnel
		return commitOK, 0, current
	}

	m.tunnels[connectionId] = tunnel
	return commitOK, 0, nil
}
