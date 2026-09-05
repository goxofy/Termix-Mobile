package main

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"tailscale.com/ipn/store/mem"
)

type fakeNode struct {
	upStarted    chan struct{}
	upRelease    chan struct{}
	upErr        error
	closeStarted chan struct{}
	closeRelease chan struct{}
	closeErr     error
	upOnce       sync.Once
	closeOnce    sync.Once
}

func (n *fakeNode) Up(context.Context) error {
	if n.upStarted != nil {
		n.upOnce.Do(func() { close(n.upStarted) })
	}
	if n.upRelease != nil {
		<-n.upRelease
	}
	return n.upErr
}

func (n *fakeNode) Close() error {
	if n.closeStarted != nil {
		n.closeOnce.Do(func() { close(n.closeStarted) })
	}
	if n.closeRelease != nil {
		<-n.closeRelease
	}
	return n.closeErr
}

func (*fakeNode) Dial(context.Context, string, string) (net.Conn, error) {
	return nil, errors.New("fake dial is not configured")
}

func (*fakeNode) BackendRunning(context.Context) bool { return true }

func (*fakeNode) TailscaleIPs() (netip.Addr, netip.Addr) {
	return netip.Addr{}, netip.Addr{}
}

func resetLifecycleForTest(t *testing.T) {
	t.Helper()

	mu.Lock()
	cleanup := activeCleanup
	mu.Unlock()
	if cleanup != nil {
		select {
		case <-cleanup.done:
		case <-time.After(time.Second):
			t.Fatal("previous native cleanup did not finish")
		}
	}
	_ = stopAllForwardEntries()

	mu.Lock()
	server = nil
	serverGeneration = 0
	serverRouteGeneration = 0
	state = nodeIdle
	startingOperation = nil
	activeCleanup = nil
	generation = 0
	configured = false
	currentRoute = routeSnapshot{}
	nextCancelableID = 0
	operationCancels = map[uint64]context.CancelFunc{}
	clearConfigLocked()
	mu.Unlock()

	forwardMu.Lock()
	forwards = map[string]*forwardEntry{}
	forwardGeneration = 0
	forwardMu.Unlock()

	setErr(nil)
	nodeFactory = func(config nodeConfig) tailscaleNode {
		return &tsnetNode{server: newTSNetServer(config)}
	}
	upCallDeadline = 90 * time.Second
	closeWaitBudget = 3 * time.Second
	startForwardProbeTimeout = 10 * time.Second
	forwardHealthProbeTimeout = 5 * time.Second
}

func configureForTest(t *testing.T) {
	t.Helper()
	if err := configureNode(nodeConfig{
		authKey:  "tskey-auth-test",
		hostname: "termix-test",
		stateDir: t.TempDir(),
	}); err != nil {
		t.Fatalf("configureNode: %v", err)
	}
}

func waitForNodeState(t *testing.T, want nodeState) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		got := state
		mu.Unlock()
		if got == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	mu.Lock()
	got := state
	mu.Unlock()
	t.Fatalf("node state = %v; want %v", got, want)
}

func TestCancelCurrentOperationReturnsBeforeBlockedUp(t *testing.T) {
	resetLifecycleForTest(t)
	fake := &fakeNode{
		upStarted:    make(chan struct{}),
		upRelease:    make(chan struct{}),
		closeStarted: make(chan struct{}),
	}
	nodeFactory = func(nodeConfig) tailscaleNode { return fake }
	configureForTest(t)

	upResult := make(chan error, 1)
	go func() { upResult <- upNode() }()
	<-fake.upStarted

	startedAt := time.Now()
	cancelCurrentOperation()
	if elapsed := time.Since(startedAt); elapsed > 50*time.Millisecond {
		t.Fatalf("cancel blocked for %s", elapsed)
	}
	select {
	case err := <-upResult:
		if err == nil || !strings.Contains(err.Error(), "canceled") {
			t.Fatalf("upNode error = %v; want cancellation", err)
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("upNode did not honor immediate cancellation")
	}
	waitForNodeState(t, nodeClosing)
	if err := configureNode(nodeConfig{hostname: "retry", stateDir: t.TempDir()}); err == nil ||
		!strings.Contains(err.Error(), "cleanup still in progress") {
		t.Fatalf("configure while cleaning = %v; want retryable busy error", err)
	}

	close(fake.upRelease)
	select {
	case <-fake.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("candidate cleanup did not close the node")
	}
	waitForNodeState(t, nodeIdle)
}

func TestUpHasHardOuterDeadlineAndEventuallyCleans(t *testing.T) {
	resetLifecycleForTest(t)
	upCallDeadline = 25 * time.Millisecond
	fake := &fakeNode{
		upStarted:    make(chan struct{}),
		upRelease:    make(chan struct{}),
		closeStarted: make(chan struct{}),
	}
	nodeFactory = func(nodeConfig) tailscaleNode { return fake }
	configureForTest(t)

	startedAt := time.Now()
	err := upNode()
	if err == nil || !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("upNode error = %v; want hard deadline", err)
	}
	if elapsed := time.Since(startedAt); elapsed > 200*time.Millisecond {
		t.Fatalf("upNode exceeded outer bound: %s", elapsed)
	}
	waitForNodeState(t, nodeClosing)

	close(fake.upRelease)
	select {
	case <-fake.closeStarted:
	case <-time.After(time.Second):
		t.Fatal("deadline cleanup did not eventually close candidate")
	}
	waitForNodeState(t, nodeIdle)
}

func TestCloseIsBoundedWhileCleanupContinues(t *testing.T) {
	resetLifecycleForTest(t)
	closeWaitBudget = 25 * time.Millisecond
	fake := &fakeNode{
		closeStarted: make(chan struct{}),
		closeRelease: make(chan struct{}),
	}
	nodeFactory = func(nodeConfig) tailscaleNode { return fake }
	configureForTest(t)
	if err := upNode(); err != nil {
		t.Fatalf("upNode: %v", err)
	}

	startedAt := time.Now()
	err := closeNode()
	if err == nil || !strings.Contains(err.Error(), "cleanup still in progress") {
		t.Fatalf("closeNode error = %v; want bounded cleanup error", err)
	}
	if elapsed := time.Since(startedAt); elapsed > 200*time.Millisecond {
		t.Fatalf("closeNode exceeded wait budget: %s", elapsed)
	}
	select {
	case <-fake.closeStarted:
	default:
		t.Fatal("background Close was not started")
	}
	if err := configureNode(nodeConfig{hostname: "retry", stateDir: t.TempDir()}); err == nil ||
		!strings.Contains(err.Error(), "cleanup still in progress") {
		t.Fatalf("configure while Close blocks = %v; want retryable busy error", err)
	}

	close(fake.closeRelease)
	waitForNodeState(t, nodeIdle)
	mu.Lock()
	stillConfigured := configured
	mu.Unlock()
	if stillConfigured {
		t.Fatal("explicit Close did not clear configuration after eventual cleanup")
	}
	if err := configureNode(nodeConfig{hostname: "retry", stateDir: t.TempDir()}); err != nil {
		t.Fatalf("configure after cleanup: %v", err)
	}
}

func TestRouteGenerationInvalidatesRunningNode(t *testing.T) {
	resetLifecycleForTest(t)
	fake := &fakeNode{}
	nodeFactory = func(nodeConfig) tailscaleNode { return fake }
	updateRoutePolicy(routePolicyPhysical, "en0", 1)
	configureForTest(t)
	if err := upNode(); err != nil {
		t.Fatalf("upNode: %v", err)
	}

	node, nodeGeneration, route, ok := runningNodeSnapshot()
	if !ok || route.generation != 1 {
		t.Fatalf("initial running snapshot = (%v, %d, %+v, %v)", node, nodeGeneration, route, ok)
	}
	dialContext := routeAwareDialContext(node, nodeGeneration, route.generation)
	updateRoutePolicy(routePolicySystemVPN, "", 2)
	if _, err := dialContext(context.Background(), "tcp", "example.ts.net:443"); err == nil ||
		!strings.Contains(err.Error(), "stale") {
		t.Fatalf("route-aware dial after network change = %v; want stale-node error", err)
	}
	if isNodeCurrent(node, nodeGeneration, route.generation) {
		t.Fatal("node stayed current after material route generation changed")
	}
	if _, _, _, ok := runningNodeSnapshot(); ok {
		t.Fatal("stale route generation was exposed as a running node")
	}
	if err := closeNode(); err != nil {
		t.Fatalf("closeNode: %v", err)
	}
}

func TestCancelCurrentOperationCancelsRegisteredProbe(t *testing.T) {
	resetLifecycleForTest(t)
	fake := &fakeNode{}
	mu.Lock()
	state = nodeRunning
	server = fake
	generation = 7
	serverGeneration = 7
	currentRoute = routeSnapshot{generation: 3}
	serverRouteGeneration = 3
	mu.Unlock()

	ctx, release, ok := registerCancelableOperation(time.Second, fake, 7, 3)
	if !ok {
		t.Fatal("probe registration unexpectedly failed")
	}
	defer release()
	cancelCurrentOperation()
	select {
	case <-ctx.Done():
		if !errors.Is(ctx.Err(), context.Canceled) {
			t.Fatalf("probe context error = %v; want canceled", ctx.Err())
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("registered probe was not canceled")
	}
}

func TestEphemeralNodeUsesMemoryStore(t *testing.T) {
	durable := newTSNetServer(nodeConfig{stateDir: t.TempDir()})
	if durable.Store != nil {
		t.Fatalf("durable Store = %T; want tsnet file-store default", durable.Store)
	}
	ephemeral := newTSNetServer(nodeConfig{stateDir: t.TempDir(), ephemeral: true})
	if _, ok := ephemeral.Store.(*mem.Store); !ok {
		t.Fatalf("ephemeral Store = %T; want *mem.Store", ephemeral.Store)
	}
}
