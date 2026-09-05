//go:build ios

package main

import (
	"fmt"
	"strings"

	"tailscale.com/net/netmon"
	"tailscale.com/net/netns"
)

func applyRoutePolicy(policy routePolicy, physicalName string) error {
	switch policy {
	case routePolicySystemVPN:
		// Let the Darwin socket follow the active packet-tunnel route. Guessing a
		// Wi-Fi or cellular underlay can bind Tailscale outside the system VPN.
		netns.SetDisableBindConnToInterface(true)
		return nil
	case routePolicyPhysical:
		physicalName = strings.TrimSpace(physicalName)
		if !validPhysicalInterfaceName(physicalName) {
			return fmt.Errorf("invalid physical default-route interface %q", physicalName)
		}
		netns.SetDisableBindConnToInterface(false)
		netmon.UpdateLastKnownDefaultRouteInterface(physicalName)
		return nil
	default:
		netns.SetDisableBindConnToInterface(false)
		return fmt.Errorf("no usable iOS default route is available")
	}
}
