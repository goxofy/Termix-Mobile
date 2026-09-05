// Termix Tailscale bridge: userspace tsnet node + local HTTP(S) forwards.
//
// Built as a C archive/shared library and linked into the Expo native module.
// JS talks plain HTTP to 127.0.0.1:<localPort>; this process reverse-proxies
// each request to the real remote origin over the tailnet.
package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"tailscale.com/ipn/store/mem"
	"tailscale.com/tsnet"
)

func main() {}

//export TermixTS_IsAvailable
func TermixTS_IsAvailable() C.int {
	return 1
}

type routePolicy uint8

const (
	routePolicyUnavailable routePolicy = iota
	routePolicyPhysical
	routePolicySystemVPN
)

type routeSnapshot struct {
	policy       routePolicy
	physicalName string
	generation   uint64
}

//export TermixTS_UpdateRoutePolicy
func TermixTS_UpdateRoutePolicy(policy C.int, physicalName *C.char, routeGeneration C.ulonglong) {
	name := ""
	if physicalName != nil {
		name = C.GoString(physicalName)
	}
	updateRoutePolicy(routePolicy(policy), name, uint64(routeGeneration))
}

//export TermixTS_CancelCurrentOperation
func TermixTS_CancelCurrentOperation() {
	cancelCurrentOperation()
}

type nodeConfig struct {
	authKey   string
	hostname  string
	stateDir  string
	ephemeral bool
}

type tailscaleNode interface {
	Up(context.Context) error
	Close() error
	Dial(context.Context, string, string) (net.Conn, error)
	BackendRunning(context.Context) bool
	TailscaleIPs() (netip.Addr, netip.Addr)
}

type tsnetNode struct {
	server *tsnet.Server
}

func (n *tsnetNode) Up(ctx context.Context) error {
	_, err := n.server.Up(ctx)
	return err
}

func (n *tsnetNode) Close() error {
	return n.server.Close()
}

func (n *tsnetNode) Dial(ctx context.Context, network, address string) (net.Conn, error) {
	return n.server.Dial(ctx, network, address)
}

func (n *tsnetNode) BackendRunning(ctx context.Context) bool {
	client, err := n.server.LocalClient()
	if err != nil {
		return false
	}
	status, err := client.StatusWithoutPeers(ctx)
	return err == nil && status != nil && strings.EqualFold(status.BackendState, "Running")
}

func (n *tsnetNode) TailscaleIPs() (netip.Addr, netip.Addr) {
	return n.server.TailscaleIPs()
}

func newTSNetServer(config nodeConfig) *tsnet.Server {
	s := &tsnet.Server{
		Hostname:  config.hostname,
		AuthKey:   config.authKey,
		Dir:       config.stateDir,
		Ephemeral: config.ephemeral,
	}
	if config.ephemeral {
		// Ephemeral nodes must never recover an identity from tailscaled.state.
		// Keeping the state in memory also guarantees every process launch uses
		// the supplied reusable auth key instead of silently entering NeedsLogin.
		s.Store = new(mem.Store)
	}
	return s
}

var nodeFactory = func(config nodeConfig) tailscaleNode {
	return &tsnetNode{server: newTSNetServer(config)}
}

type forwardEntry struct {
	protocol        string
	remoteHost      string
	remotePort      int
	localPort       int
	server          tailscaleNode
	nodeGeneration  uint64
	routeGeneration uint64
	listener        net.Listener
	cancel          context.CancelFunc
	requestCtx      context.Context
	proxy           *http.Server
	transport       *http.Transport
	connections     map[net.Conn]struct{}
	connMu          sync.Mutex
	stopOnce        sync.Once
	stopErr         error
}

// forwardListener wraps accepted connections so hijacked WebSockets can remove
// themselves from forwardEntry.connections when their real Close occurs.
// net/http treats StateHijacked as terminal and never emits StateClosed after it.
type forwardListener struct {
	net.Listener
	entry *forwardEntry
}

func (l *forwardListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &forwardConnection{Conn: conn, entry: l.entry}, nil
}

type forwardConnection struct {
	net.Conn
	entry *forwardEntry
}

func (c *forwardConnection) Close() error {
	err := c.Conn.Close()
	c.entry.untrackConnection(c)
	return err
}

func (c *forwardConnection) CloseRead() error {
	if conn, ok := c.Conn.(interface{ CloseRead() error }); ok {
		return conn.CloseRead()
	}
	return nil
}

func (c *forwardConnection) CloseWrite() error {
	if conn, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return conn.CloseWrite()
	}
	return nil
}

type nodeState uint8

const (
	nodeIdle nodeState = iota
	nodeStarting
	nodeRunning
	nodeClosing
)

type upOperation struct {
	node           tailscaleNode
	nodeGeneration uint64
	route          routeSnapshot
	ctx            context.Context
	cancel         context.CancelFunc
	done           chan struct{}
	err            error
}

type cleanupTask struct {
	operation   *upOperation
	node        tailscaleNode
	done        chan struct{}
	clearConfig bool // protected by mu
	err         error
}

var (
	// mu protects lifecycle, configuration, route generation, and cancelable
	// operation registration. It is never held while calling a tsnet method.
	mu                    sync.Mutex
	errorMu               sync.Mutex
	forwardMu             sync.Mutex
	routeApplyMu          sync.Mutex
	server                tailscaleNode
	serverGeneration      uint64
	serverRouteGeneration uint64
	state                 = nodeIdle
	startingOperation     *upOperation
	activeCleanup         *cleanupTask
	generation            uint64
	forwardGeneration     uint64
	forwards              = map[string]*forwardEntry{}
	lastError             string
	configured            bool
	currentRoute          routeSnapshot
	nextCancelableID      uint64
	operationCancels      = map[uint64]context.CancelFunc{}

	cfgAuthKey   string
	cfgHostname  string
	cfgStateDir  string
	cfgEphemeral bool

	// Variables rather than constants make the hard bounds injectable in tests.
	upCallDeadline            = 90 * time.Second
	closeWaitBudget           = 3 * time.Second
	startForwardProbeTimeout  = 10 * time.Second
	forwardHealthProbeTimeout = 5 * time.Second
)

// clearConfigLocked forgets credentials and state-directory ownership after an
// explicit native close. The caller must hold mu.
func clearConfigLocked() {
	configured = false
	cfgAuthKey = ""
	cfgHostname = ""
	cfgStateDir = ""
	cfgEphemeral = false
}

func setErr(err error) {
	errorMu.Lock()
	defer errorMu.Unlock()
	if err == nil {
		lastError = ""
		return
	}
	lastError = err.Error()
}

func forwardKey(protocol, host string, remotePort, localPort int) string {
	return fmt.Sprintf(
		"%s://%s:%d->%d",
		strings.ToLower(strings.TrimSpace(protocol)),
		normalizeForwardHost(host),
		remotePort,
		localPort,
	)
}

func configureNode(config nodeConfig) error {
	config.hostname = strings.TrimSpace(config.hostname)
	config.stateDir = strings.TrimSpace(config.stateDir)
	if config.hostname == "" {
		config.hostname = "termix-mobile"
	}
	if config.stateDir == "" {
		return fmt.Errorf("state directory is required")
	}
	if err := os.MkdirAll(config.stateDir, 0o700); err != nil {
		return fmt.Errorf("create state dir: %w", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if state == nodeClosing || activeCleanup != nil {
		return fmt.Errorf("tailscale cleanup still in progress; retry configure shortly")
	}
	if state != nodeIdle || server != nil || startingOperation != nil {
		return fmt.Errorf("already started; call TermixTS_Close before reconfigure")
	}

	cfgAuthKey = config.authKey
	cfgHostname = config.hostname
	cfgStateDir = config.stateDir
	cfgEphemeral = config.ephemeral
	configured = true

	// On Android, $XDG_CACHE_HOME / $HOME are unset, so logpolicy's
	// os.UserCacheDir() fails and tsnet panics. Point it at a writable parent.
	if runtime.GOOS == "android" {
		cacheParent := filepath.Dir(cfgStateDir)
		if err := os.MkdirAll(cacheParent, 0o700); err == nil {
			_ = os.Setenv("XDG_CACHE_HOME", cacheParent)
		}
	}
	return nil
}

//export TermixTS_Configure
func TermixTS_Configure(authKey, hostname, stateDir *C.char, ephemeral C.int) C.int {
	err := configureNode(nodeConfig{
		authKey:   C.GoString(authKey),
		hostname:  C.GoString(hostname),
		stateDir:  C.GoString(stateDir),
		ephemeral: ephemeral != 0,
	})
	if err != nil {
		setErr(err)
		return -1
	}
	setErr(nil)
	return 0
}

func updateRoutePolicy(policy routePolicy, physicalName string, routeGeneration uint64) {
	physicalName = strings.TrimSpace(physicalName)
	if policy == routePolicyPhysical && !validPhysicalInterfaceName(physicalName) {
		policy = routePolicyUnavailable
		physicalName = ""
	}
	if policy != routePolicyPhysical {
		physicalName = ""
	}
	if policy > routePolicySystemVPN {
		policy = routePolicyUnavailable
	}

	mu.Lock()
	if routeGeneration < currentRoute.generation {
		mu.Unlock()
		return
	}
	currentRoute = routeSnapshot{
		policy:       policy,
		physicalName: physicalName,
		generation:   routeGeneration,
	}
	snapshot := currentRoute
	mu.Unlock()

	// Apply promptly as well as at every construction/dial boundary. The helper
	// rechecks generation under routeApplyMu so an older publication cannot win.
	_ = applyRouteSnapshot(snapshot)
}

func validPhysicalInterfaceName(name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	return name != "" && !strings.HasPrefix(name, "utun") && name != "lo" && name != "lo0"
}

func applyRouteSnapshot(snapshot routeSnapshot) error {
	routeApplyMu.Lock()
	defer routeApplyMu.Unlock()

	mu.Lock()
	isCurrent := currentRoute == snapshot
	mu.Unlock()
	if !isCurrent {
		return fmt.Errorf("network route changed while applying policy")
	}
	return applyRoutePolicy(snapshot.policy, snapshot.physicalName)
}

func currentRouteSnapshot() routeSnapshot {
	mu.Lock()
	defer mu.Unlock()
	return currentRoute
}

func runUpOperation(operation *upOperation) {
	operation.err = operation.node.Up(operation.ctx)
	close(operation.done)
}

func beginCleanupLocked(operation *upOperation, node tailscaleNode, clearConfig bool) *cleanupTask {
	if activeCleanup != nil {
		if clearConfig {
			activeCleanup.clearConfig = true
		}
		return activeCleanup
	}
	state = nodeClosing
	task := &cleanupTask{
		operation:   operation,
		node:        node,
		done:        make(chan struct{}),
		clearConfig: clearConfig,
	}
	activeCleanup = task
	go finalizeCleanup(task)
	return task
}

func finalizeCleanup(task *cleanupTask) {
	if task.operation != nil {
		<-task.operation.done
	}
	if task.node != nil {
		task.err = task.node.Close()
	}

	mu.Lock()
	if activeCleanup == task {
		if startingOperation == task.operation {
			startingOperation = nil
		}
		if server == task.node {
			server = nil
		}
		serverGeneration = 0
		serverRouteGeneration = 0
		state = nodeIdle
		if task.clearConfig {
			clearConfigLocked()
		}
		activeCleanup = nil
		close(task.done)
	}
	mu.Unlock()
}

func ensureUpCleanup(operation *upOperation, clearConfig bool) *cleanupTask {
	mu.Lock()
	defer mu.Unlock()
	if activeCleanup != nil {
		if clearConfig {
			activeCleanup.clearConfig = true
		}
		return activeCleanup
	}
	if startingOperation != operation {
		return nil
	}
	return beginCleanupLocked(operation, operation.node, clearConfig)
}

func upNode() error {
	mu.Lock()
	switch state {
	case nodeRunning:
		if server != nil && serverGeneration == generation && serverRouteGeneration == currentRoute.generation {
			mu.Unlock()
			return nil
		}
		mu.Unlock()
		return fmt.Errorf("tailscale node is stale after cancellation or network change; call Close before Up")
	case nodeStarting:
		mu.Unlock()
		return fmt.Errorf("tailscale up is already in progress")
	case nodeClosing:
		mu.Unlock()
		return fmt.Errorf("tailscale cleanup still in progress; retry Up shortly")
	}
	if !configured || cfgStateDir == "" {
		mu.Unlock()
		return fmt.Errorf("tailscale is not configured")
	}
	config := nodeConfig{
		authKey:   cfgAuthKey,
		hostname:  cfgHostname,
		stateDir:  cfgStateDir,
		ephemeral: cfgEphemeral,
	}
	route := currentRoute
	mu.Unlock()

	// netns policy is process-wide and must be established before tsnet creates
	// its live netmon. A later hint cannot repair that monitor.
	if err := applyRouteSnapshot(route); err != nil {
		return fmt.Errorf("apply network route before tailscale up: %w", err)
	}
	node := nodeFactory(config)
	ctx, cancel := context.WithTimeout(context.Background(), upCallDeadline)
	operation := &upOperation{
		node:   node,
		route:  route,
		ctx:    ctx,
		cancel: cancel,
		done:   make(chan struct{}),
	}

	mu.Lock()
	if state != nodeIdle || activeCleanup != nil || currentRoute != route {
		mu.Unlock()
		cancel()
		_ = node.Close()
		return fmt.Errorf("network or tailscale lifecycle changed before Up could start")
	}
	generation++
	operation.nodeGeneration = generation
	state = nodeStarting
	startingOperation = operation
	mu.Unlock()

	// Android 11+ blocks the netlink enumeration used by net.Interfaces.
	// Register the ioctl-backed getter before netmon is created inside Up.
	registerAndroidInterfaceGetter()
	go runUpOperation(operation)

	select {
	case <-operation.done:
		cancel()
		if operation.err != nil {
			ensureUpCleanup(operation, false)
			return fmt.Errorf("tailscale up: %w", operation.err)
		}
		// Reapply after startup, then verify both lifecycle and route generations
		// before publishing this node.
		if err := applyRouteSnapshot(operation.route); err != nil {
			ensureUpCleanup(operation, false)
			return fmt.Errorf("tailscale route changed during Up: %w", err)
		}

		mu.Lock()
		publish := state == nodeStarting && startingOperation == operation &&
			generation == operation.nodeGeneration && currentRoute == operation.route
		if publish {
			server = operation.node
			serverGeneration = operation.nodeGeneration
			serverRouteGeneration = operation.route.generation
			startingOperation = nil
			state = nodeRunning
		}
		mu.Unlock()
		if publish {
			return nil
		}
		ensureUpCleanup(operation, false)
		return fmt.Errorf("tailscale up was superseded by cancellation or network change; cleanup continues in background")
	case <-ctx.Done():
		// Do not wait for Server.Up: older networking stacks can ignore context
		// cancellation while rebuilding routes. The finalizer owns the candidate
		// until Up returns and Close completes.
		ensureUpCleanup(operation, false)
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("tailscale up exceeded %s; cleanup continues in background", upCallDeadline)
		}
		return fmt.Errorf("tailscale up canceled; cleanup continues in background")
	}
}

//export TermixTS_Up
func TermixTS_Up() C.int {
	if err := upNode(); err != nil {
		setErr(err)
		return -1
	}
	setErr(nil)
	return 0
}

func cancelCurrentOperation() {
	mu.Lock()
	generation++
	cancels := make([]context.CancelFunc, 0, len(operationCancels)+1)
	if startingOperation != nil && startingOperation.cancel != nil {
		cancels = append(cancels, startingOperation.cancel)
		if state == nodeStarting {
			beginCleanupLocked(startingOperation, startingOperation.node, false)
		}
	}
	for _, cancel := range operationCancels {
		cancels = append(cancels, cancel)
	}
	mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

func registerCancelableOperation(
	timeout time.Duration,
	node tailscaleNode,
	nodeGeneration uint64,
	routeGeneration uint64,
) (context.Context, func(), bool) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	mu.Lock()
	if state != nodeRunning || server != node || generation != nodeGeneration ||
		serverGeneration != nodeGeneration || currentRoute.generation != routeGeneration ||
		serverRouteGeneration != routeGeneration {
		mu.Unlock()
		cancel()
		return nil, nil, false
	}
	nextCancelableID++
	id := nextCancelableID
	operationCancels[id] = cancel
	mu.Unlock()

	release := func() {
		cancel()
		mu.Lock()
		delete(operationCancels, id)
		mu.Unlock()
	}
	return ctx, release, true
}

func runningNodeSnapshot() (tailscaleNode, uint64, routeSnapshot, bool) {
	mu.Lock()
	defer mu.Unlock()
	if state != nodeRunning || server == nil || serverGeneration != generation ||
		serverRouteGeneration != currentRoute.generation {
		return nil, 0, routeSnapshot{}, false
	}
	return server, serverGeneration, currentRoute, true
}

func routeAwareDialContext(
	node tailscaleNode,
	nodeGeneration uint64,
	routeGeneration uint64,
) forwardDialContext {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		mu.Lock()
		current := currentRoute
		valid := state == nodeRunning && server == node && generation == nodeGeneration &&
			serverGeneration == nodeGeneration && current.generation == routeGeneration &&
			serverRouteGeneration == routeGeneration
		mu.Unlock()
		if !valid {
			return nil, fmt.Errorf("tailscale node is stale after a network change")
		}
		if err := applyRouteSnapshot(current); err != nil {
			return nil, fmt.Errorf("apply network route before tailscale dial: %w", err)
		}
		if !isNodeCurrent(node, nodeGeneration, routeGeneration) {
			return nil, fmt.Errorf("network changed before tailscale dial")
		}
		return node.Dial(ctx, network, address)
	}
}

//export TermixTS_StartForward
func TermixTS_StartForward(protocol *C.char, remoteHost *C.char, remotePort C.int, localPortOut *C.int) C.int {
	scheme, err := normalizeForwardProtocol(C.GoString(protocol))
	if err != nil {
		setErr(err)
		return -1
	}
	host := normalizeForwardHost(C.GoString(remoteHost))
	rport := int(remotePort)
	if host == "" || rport <= 0 || rport > 65535 {
		setErr(fmt.Errorf("invalid remote host/port"))
		return -1
	}

	node, nodeGeneration, route, ok := runningNodeSnapshot()
	if !ok {
		setErr(fmt.Errorf("tailscale is not connected or is stale; call Up first"))
		return -1
	}
	if err := applyRouteSnapshot(route); err != nil {
		setErr(fmt.Errorf("apply network route before forward probe: %w", err))
		return -1
	}

	forwardMu.Lock()
	myForwardGeneration := forwardGeneration
	forwardMu.Unlock()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		setErr(fmt.Errorf("listen localhost: %w", err))
		return -1
	}

	probeCtx, releaseProbe, registered := registerCancelableOperation(
		startForwardProbeTimeout,
		node,
		nodeGeneration,
		route.generation,
	)
	if !registered {
		_ = ln.Close()
		setErr(fmt.Errorf("network changed before forward probe could start"))
		return -1
	}
	dialContext := routeAwareDialContext(node, nodeGeneration, route.generation)
	err = probeForwardTargetWithContext(probeCtx, dialContext, host, rport)
	releaseProbe()
	if err != nil {
		_ = ln.Close()
		setErr(err)
		return -1
	}
	if err := applyRouteSnapshot(route); err != nil {
		_ = ln.Close()
		setErr(fmt.Errorf("network changed after forward probe: %w", err))
		return -1
	}

	localPort := ln.Addr().(*net.TCPAddr).Port
	requestCtx, cancel := context.WithCancel(context.Background())
	entry := &forwardEntry{
		protocol:        scheme,
		remoteHost:      host,
		remotePort:      rport,
		localPort:       localPort,
		server:          node,
		nodeGeneration:  nodeGeneration,
		routeGeneration: route.generation,
		cancel:          cancel,
		requestCtx:      requestCtx,
		connections:     make(map[net.Conn]struct{}),
	}
	entry.listener = &forwardListener{Listener: ln, entry: entry}

	proxy, err := newForwardProxy(scheme, host, rport, localPort, dialContext)
	if err != nil {
		_ = ln.Close()
		cancel()
		setErr(err)
		return -1
	}
	entry.transport, _ = proxy.Transport.(*http.Transport)
	entry.proxy = &http.Server{
		Handler: forwardHandler(entry, proxy),
		ConnState: func(conn net.Conn, connState http.ConnState) {
			entry.trackConnection(conn, connState)
		},
	}
	key := forwardKey(scheme, host, rport, localPort)

	// Serialize publication with Close/StopAll. A close or route change that
	// began after the probe must not leave a listener behind the old node.
	forwardMu.Lock()
	mu.Lock()
	canPublish := state == nodeRunning && server == node && generation == nodeGeneration &&
		serverGeneration == nodeGeneration && currentRoute.generation == route.generation &&
		serverRouteGeneration == route.generation && forwardGeneration == myForwardGeneration
	mu.Unlock()
	if canPublish {
		forwards[key] = entry
	}
	forwardMu.Unlock()
	if !canPublish {
		_ = stopEntry(entry)
		setErr(fmt.Errorf("network changed; forward was not started"))
		return -1
	}

	go func() {
		if serveErr := entry.proxy.Serve(entry.listener); serveErr != nil && serveErr != http.ErrServerClosed {
			forwardMu.Lock()
			if forwards[key] == entry {
				delete(forwards, key)
			}
			forwardMu.Unlock()
			_ = stopEntry(entry)
			setErr(fmt.Errorf("serve localhost forward: %w", serveErr))
		}
	}()

	if localPortOut != nil {
		*localPortOut = C.int(localPort)
	}
	setErr(nil)
	return 0
}

func normalizeForwardHost(host string) string {
	host = strings.TrimSpace(host)
	if len(host) >= 2 && strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = host[1 : len(host)-1]
	}
	return strings.ToLower(host)
}

func probeForwardTarget(dialContext forwardDialContext, remoteHost string, remotePort int) error {
	return probeForwardTargetWithTimeout(dialContext, remoteHost, remotePort, startForwardProbeTimeout)
}

func probeForwardTargetWithTimeout(
	dialContext forwardDialContext,
	remoteHost string,
	remotePort int,
	timeout time.Duration,
) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return probeForwardTargetWithContext(ctx, dialContext, remoteHost, remotePort)
}

func probeForwardTargetWithContext(
	ctx context.Context,
	dialContext forwardDialContext,
	remoteHost string,
	remotePort int,
) error {
	address := net.JoinHostPort(remoteHost, strconv.Itoa(remotePort))
	connection, err := dialContext(ctx, "tcp", address)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return fmt.Errorf("probe Tailscale target %s canceled", address)
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("probe Tailscale target %s timed out", address)
		}
		return fmt.Errorf("probe Tailscale target %s: %w", address, err)
	}
	_ = connection.Close()
	return nil
}

func forwardHandler(entry *forwardEntry, proxy http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parent := entry.requestCtx
		if parent == nil {
			parent = context.Background()
		}
		// Abort the upstream request when either the client goes away or the
		// forward is stopped/rebuilt underneath it.
		ctx, cancel := context.WithCancel(parent)
		defer cancel()
		stop := context.AfterFunc(r.Context(), cancel)
		defer stop()
		proxy.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (entry *forwardEntry) trackConnection(conn net.Conn, state http.ConnState) {
	if state == http.StateClosed {
		entry.untrackConnection(conn)
		return
	}
	entry.connMu.Lock()
	entry.connections[conn] = struct{}{}
	entry.connMu.Unlock()
}

func (entry *forwardEntry) untrackConnection(conn net.Conn) {
	entry.connMu.Lock()
	delete(entry.connections, conn)
	entry.connMu.Unlock()
}

//export TermixTS_StopForward
func TermixTS_StopForward(protocol *C.char, remoteHost *C.char, remotePort C.int, localPort C.int) C.int {
	scheme, err := normalizeForwardProtocol(C.GoString(protocol))
	if err != nil {
		setErr(err)
		return -1
	}
	key := forwardKey(scheme, C.GoString(remoteHost), int(remotePort), int(localPort))

	forwardMu.Lock()
	entry, ok := forwards[key]
	var stopErr error
	if ok {
		delete(forwards, key)
		stopErr = stopEntry(entry)
	}
	forwardMu.Unlock()

	if !ok {
		setErr(fmt.Errorf("forward not found"))
		return -1
	}
	if stopErr != nil {
		setErr(fmt.Errorf("stop forward: %w", stopErr))
		return -1
	}
	setErr(nil)
	return 0
}

//export TermixTS_StopAllForwards
func TermixTS_StopAllForwards() C.int {
	if err := stopAllForwardEntries(); err != nil {
		setErr(fmt.Errorf("stop all forwards: %w", err))
		return -1
	}
	setErr(nil)
	return 0
}

//export TermixTS_IsForwardActive
func TermixTS_IsForwardActive(protocol *C.char, remoteHost *C.char, remotePort C.int, localPort C.int) C.int {
	scheme, err := normalizeForwardProtocol(C.GoString(protocol))
	if err != nil {
		setErr(err)
		return 0
	}
	key := forwardKey(scheme, C.GoString(remoteHost), int(remotePort), int(localPort))

	forwardMu.Lock()
	entry, ok := forwards[key]
	if ok {
		mu.Lock()
		ok = state == nodeRunning && server == entry.server &&
			generation == entry.nodeGeneration && serverGeneration == entry.nodeGeneration &&
			currentRoute.generation == entry.routeGeneration &&
			serverRouteGeneration == entry.routeGeneration
		mu.Unlock()
	}
	forwardMu.Unlock()
	if ok {
		return 1
	}
	return 0
}

//export TermixTS_ProbeForward
func TermixTS_ProbeForward(protocol *C.char, remoteHost *C.char, remotePort C.int, localPort C.int) C.int {
	scheme, err := normalizeForwardProtocol(C.GoString(protocol))
	if err != nil {
		setErr(err)
		return 0
	}
	key := forwardKey(scheme, C.GoString(remoteHost), int(remotePort), int(localPort))

	forwardMu.Lock()
	entry, ok := forwards[key]
	forwardMu.Unlock()
	if !ok {
		setErr(fmt.Errorf("forward is not active"))
		return 0
	}
	route := currentRouteSnapshot()
	if route.generation != entry.routeGeneration {
		setErr(fmt.Errorf("forward is stale after a network change"))
		return 0
	}
	if err := applyRouteSnapshot(route); err != nil {
		setErr(fmt.Errorf("apply network route before forward probe: %w", err))
		return 0
	}
	ctx, releaseProbe, registered := registerCancelableOperation(
		forwardHealthProbeTimeout,
		entry.server,
		entry.nodeGeneration,
		entry.routeGeneration,
	)
	if !registered {
		setErr(fmt.Errorf("forward is not active or became stale"))
		return 0
	}
	dialContext := routeAwareDialContext(
		entry.server,
		entry.nodeGeneration,
		entry.routeGeneration,
	)
	err = probeForwardTargetWithContext(ctx, dialContext, entry.remoteHost, entry.remotePort)
	releaseProbe()
	if err != nil {
		setErr(err)
		return 0
	}

	forwardMu.Lock()
	stillRegistered := forwards[key] == entry
	forwardMu.Unlock()
	_, _, latestRoute, stillRunning := runningNodeSnapshot()
	if !stillRegistered || !stillRunning || latestRoute.generation != entry.routeGeneration {
		setErr(fmt.Errorf("forward was replaced during probe"))
		return 0
	}
	setErr(nil)
	return 1
}

func stopAllForwardEntries() error {
	forwardMu.Lock()
	defer forwardMu.Unlock()

	forwardGeneration++
	entries := make([]*forwardEntry, 0, len(forwards))
	for key, entry := range forwards {
		delete(forwards, key)
		entries = append(entries, entry)
	}

	var stopErrors []error
	for _, entry := range entries {
		if err := stopEntry(entry); err != nil {
			stopErrors = append(stopErrors, err)
		}
	}
	return errors.Join(stopErrors...)
}

func stopEntry(entry *forwardEntry) error {
	if entry == nil {
		return nil
	}
	entry.stopOnce.Do(func() {
		var stopErrors []error
		if entry.cancel != nil {
			entry.cancel()
		}
		if entry.proxy != nil {
			if err := entry.proxy.Close(); isUnexpectedCloseError(err) {
				stopErrors = append(stopErrors, fmt.Errorf("close HTTP proxy: %w", err))
			}
		}
		if entry.listener != nil {
			if err := entry.listener.Close(); isUnexpectedCloseError(err) {
				stopErrors = append(stopErrors, fmt.Errorf("close localhost listener: %w", err))
			}
		}
		if entry.transport != nil {
			entry.transport.CloseIdleConnections()
		}

		entry.connMu.Lock()
		connections := make([]net.Conn, 0, len(entry.connections))
		for conn := range entry.connections {
			connections = append(connections, conn)
		}
		entry.connMu.Unlock()
		for _, conn := range connections {
			if err := conn.Close(); isUnexpectedCloseError(err) {
				stopErrors = append(stopErrors, fmt.Errorf("close proxy connection: %w", err))
			}
		}
		entry.stopErr = errors.Join(stopErrors...)
	})
	return entry.stopErr
}

func isUnexpectedCloseError(err error) bool {
	return err != nil && !errors.Is(err, net.ErrClosed) && !errors.Is(err, http.ErrServerClosed)
}

func isNodeCurrent(node tailscaleNode, nodeGeneration, routeGeneration uint64) bool {
	mu.Lock()
	defer mu.Unlock()
	return state == nodeRunning && server == node && generation == nodeGeneration &&
		serverGeneration == nodeGeneration && currentRoute.generation == routeGeneration &&
		serverRouteGeneration == routeGeneration
}

//export TermixTS_IsUp
func TermixTS_IsUp() C.int {
	node, nodeGeneration, route, ok := runningNodeSnapshot()
	if !ok {
		return 0
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if !node.BackendRunning(ctx) {
		return 0
	}
	if isNodeCurrent(node, nodeGeneration, route.generation) {
		return 1
	}
	return 0
}

//export TermixTS_GetIPs
func TermixTS_GetIPs() *C.char {
	node, nodeGeneration, route, ok := runningNodeSnapshot()
	if !ok {
		return C.CString("")
	}
	ip4, ip6 := node.TailscaleIPs()
	if !isNodeCurrent(node, nodeGeneration, route.generation) {
		return C.CString("")
	}
	parts := make([]string, 0, 2)
	if ip4.IsValid() {
		parts = append(parts, ip4.String())
	}
	if ip6.IsValid() {
		parts = append(parts, ip6.String())
	}
	return C.CString(strings.Join(parts, ","))
}

//export TermixTS_LastError
func TermixTS_LastError() *C.char {
	errorMu.Lock()
	defer errorMu.Unlock()
	return C.CString(lastError)
}

func closeNode() error {
	mu.Lock()
	generation++
	cancels := make([]context.CancelFunc, 0, len(operationCancels)+1)
	for _, cancel := range operationCancels {
		cancels = append(cancels, cancel)
	}

	var task *cleanupTask
	switch state {
	case nodeIdle:
		clearConfigLocked()
	case nodeStarting:
		if startingOperation != nil && startingOperation.cancel != nil {
			cancels = append(cancels, startingOperation.cancel)
		}
		task = beginCleanupLocked(startingOperation, startingOperation.node, true)
	case nodeRunning:
		node := server
		server = nil
		state = nodeClosing
		task = beginCleanupLocked(nil, node, true)
	case nodeClosing:
		task = activeCleanup
		if task != nil {
			task.clearConfig = true
		}
	}
	mu.Unlock()

	for _, cancel := range cancels {
		cancel()
	}
	stopErr := stopAllForwardEntries()
	if task == nil {
		return stopErr
	}

	timer := time.NewTimer(closeWaitBudget)
	defer timer.Stop()
	select {
	case <-task.done:
		return errors.Join(stopErr, task.err)
	case <-timer.C:
		return errors.Join(
			stopErr,
			fmt.Errorf("tailscale cleanup still in progress after %s; retry Close shortly", closeWaitBudget),
		)
	}
}

//export TermixTS_Close
func TermixTS_Close() C.int {
	if err := closeNode(); err != nil {
		setErr(err)
		return -1
	}
	setErr(nil)
	return 0
}

//export TermixTS_FreeString
func TermixTS_FreeString(p *C.char) {
	if p != nil {
		C.free(unsafe.Pointer(p))
	}
}
