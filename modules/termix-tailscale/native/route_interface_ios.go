//go:build ios

package main

import (
	"strings"

	"tailscale.com/net/netmon"
)

func updateDefaultRouteInterface(name string) {
	name = strings.TrimSpace(name)
	if name != "" {
		netmon.UpdateLastKnownDefaultRouteInterface(name)
	}
}
