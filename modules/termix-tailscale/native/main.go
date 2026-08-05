// Termix Tailscale bridge: userspace tsnet node + local TCP port forwards.
//
// Built as a C archive/shared library and linked into the Expo native module.
// JS talks to 127.0.0.1:<localPort>; this process dials the real remote over the tailnet.
package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"tailscale.com/tsnet"
)

func main() {}

type forwardEntry struct {
	remoteHost string
	remotePort int
	localPort  int
	listener   net.Listener
	cancel     context.CancelFunc
}

var (
	mu        sync.Mutex
	server    *tsnet.Server
	started   bool
	forwards  = map[string]*forwardEntry{}
	lastError string

	cfgAuthKey   string
	cfgHostname  string
	cfgStateDir  string
	cfgEphemeral bool
)

func setErr(err error) {
	if err == nil {
		lastError = ""
		return
	}
	lastError = err.Error()
}

func forwardKey(host string, remotePort, localPort int) string {
	return fmt.Sprintf("%s:%d->%d", host, remotePort, localPort)
}

//export TermixTS_Configure
func TermixTS_Configure(authKey, hostname, stateDir *C.char, ephemeral C.int) C.int {
	mu.Lock()
	defer mu.Unlock()

	if started {
		setErr(fmt.Errorf("already started; call TermixTS_Close before reconfigure"))
		return -1
	}

	cfgAuthKey = C.GoString(authKey)
	cfgHostname = C.GoString(hostname)
	cfgStateDir = C.GoString(stateDir)
	cfgEphemeral = ephemeral != 0

	if cfgHostname == "" {
		cfgHostname = "termix-mobile"
	}
	if cfgStateDir == "" {
		setErr(fmt.Errorf("state directory is required"))
		return -1
	}
	if err := os.MkdirAll(cfgStateDir, 0o700); err != nil {
		setErr(fmt.Errorf("create state dir: %w", err))
		return -1
	}

	setErr(nil)
	return 0
}

//export TermixTS_Up
func TermixTS_Up() C.int {
	mu.Lock()
	defer mu.Unlock()

	if started && server != nil {
		setErr(nil)
		return 0
	}

	s := &tsnet.Server{
		Hostname:  cfgHostname,
		AuthKey:   cfgAuthKey,
		Dir:       cfgStateDir,
		Ephemeral: cfgEphemeral,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	if _, err := s.Up(ctx); err != nil {
		_ = s.Close()
		setErr(fmt.Errorf("tailscale up: %w", err))
		return -1
	}

	server = s
	started = true
	setErr(nil)
	return 0
}

//export TermixTS_StartForward
func TermixTS_StartForward(remoteHost *C.char, remotePort C.int, localPortOut *C.int) C.int {
	mu.Lock()
	defer mu.Unlock()

	if !started || server == nil {
		setErr(fmt.Errorf("tailscale is not connected; call Up first"))
		return -1
	}

	host := strings.TrimSpace(C.GoString(remoteHost))
	rport := int(remotePort)
	if host == "" || rport <= 0 || rport > 65535 {
		setErr(fmt.Errorf("invalid remote host/port"))
		return -1
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		setErr(fmt.Errorf("listen localhost: %w", err))
		return -1
	}

	localPort := ln.Addr().(*net.TCPAddr).Port
	ctx, cancel := context.WithCancel(context.Background())
	entry := &forwardEntry{
		remoteHost: host,
		remotePort: rport,
		localPort:  localPort,
		listener:   ln,
		cancel:     cancel,
	}
	key := forwardKey(host, rport, localPort)
	forwards[key] = entry

	go acceptLoop(ctx, entry)

	if localPortOut != nil {
		*localPortOut = C.int(localPort)
	}
	setErr(nil)
	return 0
}

func acceptLoop(ctx context.Context, entry *forwardEntry) {
	for {
		conn, err := entry.listener.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
				// transient; keep going until cancelled
				if ne, ok := err.(net.Error); ok && ne.Temporary() {
					time.Sleep(50 * time.Millisecond)
					continue
				}
				return
			}
		}
		go proxyConn(ctx, conn, entry.remoteHost, entry.remotePort)
	}
}

func proxyConn(ctx context.Context, local net.Conn, remoteHost string, remotePort int) {
	defer local.Close()

	mu.Lock()
	s := server
	mu.Unlock()
	if s == nil {
		return
	}

	addr := net.JoinHostPort(remoteHost, strconv.Itoa(remotePort))
	dialCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	remote, err := s.Dial(dialCtx, "tcp", addr)
	if err != nil {
		return
	}
	defer remote.Close()

	errc := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(remote, local)
		errc <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(local, remote)
		errc <- struct{}{}
	}()

	select {
	case <-ctx.Done():
	case <-errc:
	}
}

//export TermixTS_StopForward
func TermixTS_StopForward(remoteHost *C.char, remotePort C.int, localPort C.int) C.int {
	mu.Lock()
	defer mu.Unlock()

	host := C.GoString(remoteHost)
	key := forwardKey(host, int(remotePort), int(localPort))
	entry, ok := forwards[key]
	if !ok {
		setErr(fmt.Errorf("forward not found"))
		return -1
	}
	stopEntry(entry)
	delete(forwards, key)
	setErr(nil)
	return 0
}

//export TermixTS_StopAllForwards
func TermixTS_StopAllForwards() C.int {
	mu.Lock()
	defer mu.Unlock()
	for k, entry := range forwards {
		stopEntry(entry)
		delete(forwards, k)
	}
	setErr(nil)
	return 0
}

func stopEntry(entry *forwardEntry) {
	if entry.cancel != nil {
		entry.cancel()
	}
	if entry.listener != nil {
		_ = entry.listener.Close()
	}
}

//export TermixTS_IsUp
func TermixTS_IsUp() C.int {
	mu.Lock()
	defer mu.Unlock()
	if started && server != nil {
		return 1
	}
	return 0
}

//export TermixTS_GetIPs
func TermixTS_GetIPs() *C.char {
	mu.Lock()
	s := server
	mu.Unlock()
	if s == nil {
		return C.CString("")
	}
	ip4, ip6 := s.TailscaleIPs()
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
	mu.Lock()
	defer mu.Unlock()
	return C.CString(lastError)
}

//export TermixTS_Close
func TermixTS_Close() C.int {
	mu.Lock()
	defer mu.Unlock()

	for k, entry := range forwards {
		stopEntry(entry)
		delete(forwards, k)
	}

	if server != nil {
		_ = server.Close()
		server = nil
	}
	started = false
	setErr(nil)
	return 0
}

//export TermixTS_FreeString
func TermixTS_FreeString(p *C.char) {
	if p != nil {
		C.free(unsafe.Pointer(p))
	}
}
