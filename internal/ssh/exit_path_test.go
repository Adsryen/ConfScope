package ssh

// 退出路径的并发判据（轮71）。
//
// 为什么必须有这几条：v1.9.9 的用户点「退出并安装」之后，安装程序永远停在
// 「等待 ConfScope 退出」—— 窗口早就没了，进程却不退。原因是 Start() 全程持锁做拨号，
// Stop/StopAll 排在它后面拿不到锁。这类缺陷在真机上只能靠运气复现（要正好撞上半开的
// 跳板机），所以这里用假 dialer / 假 listener 把它变成确定性用例：
// 「拨号可以卡任意久」是前提，超时即判红。
//
// 变异对照（改回去的人请逐条确认这些用例会变红）：
//   - 把 t.dialer 的调用移回 t.mu 临界区内 → TestStopIsNotBlockedByPendingDial 必红；
//   - 让 CreateTunnel 重新持 m.mu 跨越 Start → TestManagerStaysUsableWhileOneTunnelDials 必红；
//   - 删掉 StopAllWithCeiling 的上限 → TestStopAllWithCeilingNamesStuckConnection 必红；
//   - 让 StopTunnel 不追发作废计数 → TestStopTunnelDuringDialDoesNotResurrectTunnel 必红。

import (
	"errors"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// --- 测试替身 -------------------------------------------------------------

type fakeClient struct {
	closeCalls atomic.Int32
}

func (c *fakeClient) Dial(network, addr string) (net.Conn, error) {
	return nil, errors.New("fake client: no channel")
}

func (c *fakeClient) Close() error {
	c.closeCalls.Add(1)
	return nil
}

type fakeListener struct {
	addr       *net.TCPAddr
	closeCalls atomic.Int32
	// block 非空时 Close 一直等到那个 channel 关闭 —— 扮演「系统暂时不放手的那一类句柄」。
	block <-chan struct{}
}

func (l *fakeListener) Accept() (net.Conn, error) {
	return nil, errors.New("fake listener: no connection")
}

func (l *fakeListener) Close() error {
	if l.block != nil {
		<-l.block
	}
	l.closeCalls.Add(1)
	return nil
}

func (l *fakeListener) Addr() net.Addr { return l.addr }

// gateDialer 把「拨号」变成由测试决定的动作：每次走到 dialer 时把假客户端递出来，
// 然后阻塞在 release 上，由测试决定什么时候放行（或一直不放行）。
// listen 同时按需产出新的假 listener，便于断言「到底关了几次、关的是哪一条」。
type gateDialer struct {
	entered chan *fakeClient
	release chan struct{}

	mu        sync.Mutex
	listeners []*fakeListener
	port      int
	// blockClose 非空时，新 listener 的 Close 会卡在那里。
	blockClose <-chan struct{}
}

func newGateDialer(port int) *gateDialer {
	return &gateDialer{
		entered: make(chan *fakeClient, 8),
		release: make(chan struct{}),
		port:    port,
	}
}

func (g *gateDialer) dial(addr string, cfg *ssh.ClientConfig) (sshClientConn, error) {
	client := &fakeClient{}
	g.entered <- client
	select {
	case <-g.release:
		return client, nil
	case <-time.After(5 * time.Second):
		return nil, errors.New("test deadline: dial was never released")
	}
}

func (g *gateDialer) listen(network, address string) (net.Listener, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	listener := &fakeListener{
		addr:  &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: g.port},
		block: g.blockClose,
	}
	g.listeners = append(g.listeners, listener)
	return listener, nil
}

// latestListener 取最近一次建立的假 listener（用例里各条隧道的端口互不相同）。
func (g *gateDialer) latestListener(t *testing.T) *fakeListener {
	t.Helper()

	g.mu.Lock()
	defer g.mu.Unlock()

	if len(g.listeners) == 0 {
		t.Fatal("还没有建立任何假 listener")
	}
	return g.listeners[len(g.listeners)-1]
}

// waitDialing 等 dialer 真的进到拨号里，返回那一个假客户端。
func (g *gateDialer) waitDialing(t *testing.T) *fakeClient {
	t.Helper()

	select {
	case client := <-g.entered:
		return client
	case <-time.After(2 * time.Second):
		t.Fatal("dialer 根本没被进入：隧道压根没开始拨号")
	}
	return nil
}

func withGate(tunnel *Tunnel, gate *gateDialer) *Tunnel {
	tunnel.dialer = gate.dial
	tunnel.listenFn = gate.listen
	return tunnel
}

// mustReturnWithin 断言 fn 在 budget 内返回；超时判红并点名卡住的是谁。
func mustReturnWithin(t *testing.T, budget time.Duration, what string, fn func()) {
	t.Helper()

	done := make(chan struct{})
	go func() {
		fn()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(budget):
		t.Fatalf("%s 在 %s 内没有返回 —— 退出路径被别的东西拖住了", what, budget)
	}
}

func testTunnelConfig(host string) Config {
	return Config{
		Host:       host,
		Port:       22,
		Username:   "root",
		AuthType:   "password",
		Password:   "secret",
		RemoteHost: "nacos.internal",
		RemotePort: 8848,
	}
}

func tunnelWithFakeParts(config Config, listener *fakeListener) (*Tunnel, *fakeClient) {
	client := &fakeClient{}
	return &Tunnel{config: config, listener: listener, sshClient: client, localPort: listener.addr.Port}, client
}

// --- A5：拨号阻塞期间必须能立刻停止 ---------------------------------------

func TestStopIsNotBlockedByPendingDial(t *testing.T) {
	gate := newGateDialer(33000)
	tunnel := withGate(NewTunnel(testTunnelConfig("jump-a"), NewKnownHosts("")), gate)

	started := make(chan int, 1)
	errs := make(chan error, 1)
	go func() {
		port, err := tunnel.Start()
		if err != nil {
			errs <- err
			return
		}
		started <- port
	}()

	client := gate.waitDialing(t)

	// 判红点：把 dial 挪回 t.mu 临界区，这一步就会挂到超时。
	mustReturnWithin(t, 200*time.Millisecond, "Start 期间的 Stop()", tunnel.Stop)

	close(gate.release)

	select {
	case err := <-errs:
		if !strings.Contains(err.Error(), "tunnel is closed") {
			t.Fatalf("Start 的错误 = %q, 期望 tunnel is closed", err.Error())
		}
	case port := <-started:
		t.Fatalf("已经 Stop 的隧道不该建起来，got port=%d", port)
	case <-time.After(5 * time.Second):
		t.Fatal("Stop 之后 Start 既不返回也不报错：卡在临界区里")
	}

	listener := gate.latestListener(t)
	if listener.closeCalls.Load() != 1 {
		t.Fatalf("假 listener 关闭次数 = %d, 期望 1：拨号回来必须当场收回监听，不许留野端口", listener.closeCalls.Load())
	}
	if client.closeCalls.Load() != 1 {
		t.Fatalf("假 client 关闭次数 = %d, 期望 1", client.closeCalls.Load())
	}
}

func TestStopIsIdempotentAndReportsPort(t *testing.T) {
	gate := newGateDialer(33001)
	tunnel := withGate(NewTunnel(testTunnelConfig("jump-b"), NewKnownHosts("")), gate)

	close(gate.release)

	port, err := tunnel.Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if port != 33001 {
		t.Fatalf("port = %d, want 33001", port)
	}
	if got := tunnel.GetLocalPort(); got != port {
		t.Fatalf("GetLocalPort = %d, want %d", got, port)
	}

	mustReturnWithin(t, 200*time.Millisecond, "第二次 Stop()", tunnel.Stop)
	mustReturnWithin(t, 200*time.Millisecond, "第三次 Stop()", tunnel.Stop)
	// 重复 Stop 不炸、也不许吞掉 Close 动作：每次都要真的再试一次（幂等靠的是
	// listener/client 自己会返回「已经关过了」，而不是这里偷偷跳过）。
	if got := gate.latestListener(t).closeCalls.Load(); got != 2 {
		t.Fatalf("listener 关闭次数 = %d, 期望两次 Stop 各关一次", got)
	}
}

// --- A6：Manager 不许被一条卡住的隧道拖死 ---------------------------------

func TestStopAllWithCeilingNamesStuckConnection(t *testing.T) {
	blocker := make(chan struct{})
	t.Cleanup(func() { close(blocker) }) // 放掉那条卡住的 Close，别让 goroutine 悬着

	manager := NewManager(func() string { return testKnownHostsPath(t) })
	stuckListener := &fakeListener{addr: &net.TCPAddr{Port: 1}, block: blocker}
	freeListener := &fakeListener{addr: &net.TCPAddr{Port: 2}}
	stuck, _ := tunnelWithFakeParts(testTunnelConfig("stuck"), stuckListener)
	free, freeClient := tunnelWithFakeParts(testTunnelConfig("free"), freeListener)
	manager.tunnels["c_stuck"] = stuck
	manager.tunnels["c_free"] = free

	var pending []string
	mustReturnWithin(t, 1*time.Second, "StopAllWithCeiling", func() {
		pending = manager.StopAllWithCeiling(100 * time.Millisecond)
	})

	if len(pending) != 1 || pending[0] != "c_stuck" {
		t.Fatalf("pending = %v, 期望只点名卡住的那条 c_stuck", pending)
	}
	if freeListener.closeCalls.Load() != 1 || freeClient.closeCalls.Load() != 1 {
		t.Fatal("卡住的那条不该连累其它隧道：c_free 必须已经关掉")
	}
	if got := manager.ActiveConnectionIDs(); len(got) != 0 {
		t.Fatalf("ActiveConnectionIDs = %v, 期望表已清空（交接轮询靠它确认都关了）", got)
	}
}

func TestStopAllWithoutCeilingStopsEverything(t *testing.T) {
	manager := NewManager(func() string { return testKnownHostsPath(t) })
	firstListener := &fakeListener{addr: &net.TCPAddr{Port: 3}}
	secondListener := &fakeListener{addr: &net.TCPAddr{Port: 4}}
	first, firstClient := tunnelWithFakeParts(testTunnelConfig("one"), firstListener)
	second, secondClient := tunnelWithFakeParts(testTunnelConfig("two"), secondListener)
	manager.tunnels["c_one"] = first
	manager.tunnels["c_two"] = second

	manager.StopAll()

	if firstListener.closeCalls.Load() != 1 || secondListener.closeCalls.Load() != 1 {
		t.Fatal("StopAll 必须把每一条隧道的 listener 都关掉")
	}
	if firstClient.closeCalls.Load() != 1 || secondClient.closeCalls.Load() != 1 {
		t.Fatal("StopAll 必须把每一条隧道的 SSH 客户端都关掉")
	}
	if got := manager.ActiveConnectionIDs(); len(got) != 0 {
		t.Fatalf("ActiveConnectionIDs = %v, 期望为空", got)
	}
}

func TestStopAllWithCeilingReturnsNilWhenAllStopInTime(t *testing.T) {
	manager := NewManager(func() string { return testKnownHostsPath(t) })
	firstListener := &fakeListener{addr: &net.TCPAddr{Port: 5}}
	secondListener := &fakeListener{addr: &net.TCPAddr{Port: 6}}
	first, _ := tunnelWithFakeParts(testTunnelConfig("one"), firstListener)
	second, _ := tunnelWithFakeParts(testTunnelConfig("two"), secondListener)
	manager.tunnels["c_one"] = first
	manager.tunnels["c_two"] = second

	if pending := manager.StopAllWithCeiling(2 * time.Second); pending != nil {
		t.Fatalf("pending = %v, 期望两条都按时关掉", pending)
	}
}

func TestManagerStaysUsableWhileOneTunnelDials(t *testing.T) {
	gate := newGateDialer(33003)
	manager := NewManager(func() string { return testKnownHostsPath(t) })
	manager.newTunnel = func(config Config, hostKeys *KnownHosts) *Tunnel { return withGate(NewTunnel(config, hostKeys), gate) }

	// 先放一条「已经能用」的连接进去，证明拨号期间对它的操作不受影响。
	readyListener := &fakeListener{addr: &net.TCPAddr{Port: 9}}
	ready, _ := tunnelWithFakeParts(testTunnelConfig("ready"), readyListener)
	manager.tunnels["c_ready"] = ready

	creating := make(chan error, 1)
	go func() {
		_, err := manager.CreateTunnel("c_slow", testTunnelConfig("jump-e"))
		creating <- err
	}()
	gate.waitDialing(t)

	mustReturnWithin(t, 200*time.Millisecond, "ActiveConnectionIDs()", func() {
		ids := manager.ActiveConnectionIDs()
		if len(ids) != 1 || ids[0] != "c_ready" {
			t.Fatalf("ids = %v, 期望只看得见已经建好的那条", ids)
		}
	})
	mustReturnWithin(t, 200*time.Millisecond, "GetTunnel(其它连接)", func() {
		manager.GetTunnel("c_ready")
	})
	// 判红点：StopTunnel/CreateTunnel 若还持 m.mu 跨越拨号，这里必然挂住。
	mustReturnWithin(t, 200*time.Millisecond, "StopTunnel(其它连接)", func() {
		manager.StopTunnel("c_ready")
	})
	mustReturnWithin(t, 200*time.Millisecond, "StopAllWithCeiling(拨号进行中)", func() {
		manager.StopAllWithCeiling(10 * time.Millisecond)
	})

	close(gate.release)
	select {
	case err := <-creating:
		if err == nil {
			t.Fatal("StopAll 已经跑过，创建却成功了：作废计数没起作用")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("CreateTunnel 放行后仍不返回")
	}
}

// 停止请求落在拨号进行中：刚拨好的隧道必须当场收回，不许复活。
func TestStopTunnelDuringDialDoesNotResurrectTunnel(t *testing.T) {
	gate := newGateDialer(33004)
	manager := NewManager(func() string { return testKnownHostsPath(t) })
	manager.newTunnel = func(config Config, hostKeys *KnownHosts) *Tunnel { return withGate(NewTunnel(config, hostKeys), gate) }

	creating := make(chan error, 1)
	go func() {
		_, err := manager.CreateTunnel("c_racing", testTunnelConfig("jump-f"))
		creating <- err
	}()
	client := gate.waitDialing(t)

	mustReturnWithin(t, 200*time.Millisecond, "StopTunnel(拨号进行中)", func() {
		manager.StopTunnel("c_racing")
	})

	close(gate.release)
	var err error
	select {
	case err = <-creating:
	case <-time.After(5 * time.Second):
		t.Fatal("CreateTunnel 不返回")
	}
	if err == nil {
		t.Fatal("期望创建失败：用户在拨号期间已经点了停止")
	}
	if !strings.Contains(err.Error(), "stopped while connecting") {
		t.Fatalf("错误 = %q, 期望说明「拨号期间被停止」", err.Error())
	}
	if got := manager.ActiveConnectionIDs(); len(got) != 0 {
		t.Fatalf("ActiveConnectionIDs = %v, 期望隧道没复活", got)
	}
	if client.closeCalls.Load() != 1 {
		t.Fatalf("假 client 关闭次数 = %d, 期望落败的那条被当场收回", client.closeCalls.Load())
	}
	if gate.latestListener(t).closeCalls.Load() != 1 {
		t.Fatal("假 listener 没关：端口留在了监听")
	}
}

// 同配置且端口可用时必须复用，不再拨第二次，也不许把已经建好的那条关掉。
func TestConcurrentCreateReusesCommittedTunnel(t *testing.T) {
	gate := newGateDialer(33005)
	manager := NewManager(func() string { return testKnownHostsPath(t) })
	manager.newTunnel = func(config Config, hostKeys *KnownHosts) *Tunnel { return withGate(NewTunnel(config, hostKeys), gate) }
	config := testTunnelConfig("jump-g")

	firstErrs := make(chan error, 1)
	go func() {
		_, err := manager.CreateTunnel("c_race", config)
		firstErrs <- err
	}()
	firstClient := gate.waitDialing(t)
	close(gate.release)
	select {
	case err := <-firstErrs:
		if err != nil {
			t.Fatalf("第一条隧道: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("第一条隧道没建起来")
	}

	dialsBefore := len(gate.entered)
	port, err := manager.CreateTunnel("c_race", config)
	if err != nil {
		t.Fatalf("CreateTunnel(复用): %v", err)
	}
	if port != 33005 {
		t.Fatalf("port = %d, want 33005", port)
	}
	if len(gate.entered) != dialsBefore {
		t.Fatal("同配置且端口可用时不该再拨一次")
	}
	if got := manager.ActiveConnectionIDs(); len(got) != 1 {
		t.Fatalf("ActiveConnectionIDs = %v, 期望还是只有那一条", got)
	}
	if firstClient.closeCalls.Load() != 0 {
		t.Fatal("复用路径不该把已经建好的隧道关掉")
	}
}

// 换配置重建：旧的那条要在锁外停掉，新的顶上。
func TestCreateTunnelWithChangedConfigReplacesOldTunnel(t *testing.T) {
	gate := newGateDialer(33006)
	manager := NewManager(func() string { return testKnownHostsPath(t) })
	manager.newTunnel = func(config Config, hostKeys *KnownHosts) *Tunnel { return withGate(NewTunnel(config, hostKeys), gate) }

	oldListener := &fakeListener{addr: &net.TCPAddr{Port: 7}}
	oldTunnel, oldClient := tunnelWithFakeParts(testTunnelConfig("old"), oldListener)
	manager.tunnels["c_swap"] = oldTunnel

	// 放行拨号：这条用例关心的是「旧的被换掉」，不需要让拨号悬着。
	close(gate.release)

	port, err := manager.CreateTunnel("c_swap", testTunnelConfig("new"))
	if err != nil {
		t.Fatalf("CreateTunnel: %v", err)
	}
	if port != 33006 {
		t.Fatalf("port = %d, want 33006", port)
	}
	if oldListener.closeCalls.Load() != 1 || oldClient.closeCalls.Load() != 1 {
		t.Fatal("换配置后旧隧道必须被停掉")
	}
	if got := manager.GetTunnel("c_swap"); got == oldTunnel {
		t.Fatal("map 里还是旧隧道，没换成新的")
	}
}
