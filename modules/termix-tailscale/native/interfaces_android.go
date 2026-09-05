//go:build android

// Android interface enumeration replacement.
//
// Android SDK 30+ forbids ordinary apps from binding the NETLINK_ROUTE socket
// used by net.Interfaces(), producing "netlinkrib: permission denied". The
// kernel still permits an unbound RTM_GETADDR dump. We use that dump only to
// discover interface indexes and addresses, then use ordinary ioctl calls for
// names, MTUs, and flags. This is the same public-kernel-API strategy used by
// Android's NetworkInterface implementation, without relying on private Go
// runtime symbols or an additional module.
package main

import (
	"fmt"
	"net"
	"os"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
	"tailscale.com/net/netmon"
)

var registerAndroidInterfaceGetterOnce sync.Once

// registerAndroidInterfaceGetter replaces netmon's default net.Interfaces call
// before tsnet starts. Safe to call repeatedly across node rebuilds.
func registerAndroidInterfaceGetter() {
	registerAndroidInterfaceGetterOnce.Do(func() {
		netmon.RegisterInterfaceGetter(androidInterfaces)
	})
}

func androidInterfaces() ([]netmon.Interface, error) {
	tab, err := androidNetlinkRIB(syscall.RTM_GETADDR, syscall.AF_UNSPEC)
	if err != nil {
		return nil, &net.OpError{Op: "route", Net: "ip+net", Err: os.NewSyscallError("netlinkrib", err)}
	}
	messages, err := syscall.ParseNetlinkMessage(tab)
	if err != nil {
		return nil, os.NewSyscallError("parsenetlinkmessage", err)
	}

	type interfaceRecord struct {
		iface net.Interface
		addrs []net.Addr
	}
	records := make(map[uint32]*interfaceRecord)
	order := make([]uint32, 0)

	for _, message := range messages {
		if message.Header.Type != syscall.RTM_NEWADDR {
			continue
		}
		if len(message.Data) < syscall.SizeofIfAddrmsg {
			return nil, syscall.EINVAL
		}

		addrMessage := (*syscall.IfAddrmsg)(unsafe.Pointer(&message.Data[0]))
		record := records[addrMessage.Index]
		if record == nil {
			iface, interfaceErr := androidInterfaceByIndex(addrMessage.Index)
			if interfaceErr != nil {
				// Interfaces can disappear while the dump is being consumed. Match the
				// standard library's best-effort behavior and skip that stale record.
				continue
			}
			record = &interfaceRecord{iface: iface}
			records[addrMessage.Index] = record
			order = append(order, addrMessage.Index)
		}

		attributes, attributeErr := syscall.ParseNetlinkRouteAttr(&message)
		if attributeErr != nil {
			return nil, os.NewSyscallError("parsenetlinkrouteattr", attributeErr)
		}
		if addr := androidInterfaceAddress(addrMessage, attributes); addr != nil {
			record.addrs = append(record.addrs, addr)
		}
	}

	interfaces := make([]netmon.Interface, 0, len(order))
	for _, index := range order {
		record := records[index]
		if record == nil {
			continue
		}
		iface := record.iface
		interfaces = append(interfaces, netmon.Interface{
			Interface: &iface,
			AltAddrs:  record.addrs,
		})
	}
	return interfaces, nil
}

func androidInterfaceByIndex(index uint32) (net.Interface, error) {
	name, err := androidInterfaceName(index)
	if err != nil {
		return net.Interface{}, err
	}
	mtu, err := androidInterfaceMTU(name)
	if err != nil {
		return net.Interface{}, err
	}
	flags, err := androidInterfaceFlags(name)
	if err != nil {
		return net.Interface{}, err
	}
	return net.Interface{
		Index: int(index),
		MTU:   mtu,
		Name:  name,
		Flags: flags,
	}, nil
}

func androidInterfaceName(index uint32) (string, error) {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return "", err
	}
	defer unix.Close(fd)

	request, err := unix.NewIfreq("")
	if err != nil {
		return "", err
	}
	request.SetUint32(index)
	if err := unix.IoctlIfreq(fd, unix.SIOCGIFNAME, request); err != nil {
		return "", err
	}
	return request.Name(), nil
}

func androidInterfaceMTU(name string) (int, error) {
	request, err := androidInterfaceIoctl(name, unix.SIOCGIFMTU)
	if err != nil {
		return 0, err
	}
	return int(request.Uint32()), nil
}

func androidInterfaceFlags(name string) (net.Flags, error) {
	request, err := androidInterfaceIoctl(name, unix.SIOCGIFFLAGS)
	if err != nil {
		return 0, err
	}
	rawFlags := request.Uint16()
	var flags net.Flags
	if rawFlags&unix.IFF_UP != 0 {
		flags |= net.FlagUp
	}
	if rawFlags&unix.IFF_RUNNING != 0 {
		flags |= net.FlagRunning
	}
	if rawFlags&unix.IFF_BROADCAST != 0 {
		flags |= net.FlagBroadcast
	}
	if rawFlags&unix.IFF_LOOPBACK != 0 {
		flags |= net.FlagLoopback
	}
	if rawFlags&unix.IFF_POINTOPOINT != 0 {
		flags |= net.FlagPointToPoint
	}
	if rawFlags&unix.IFF_MULTICAST != 0 {
		flags |= net.FlagMulticast
	}
	return flags, nil
}

func androidInterfaceIoctl(name string, operation uint) (*unix.Ifreq, error) {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(fd)

	request, err := unix.NewIfreq(name)
	if err != nil {
		return nil, err
	}
	if err := unix.IoctlIfreq(fd, operation, request); err != nil {
		return nil, err
	}
	return request, nil
}

func androidInterfaceAddress(
	message *syscall.IfAddrmsg,
	attributes []syscall.NetlinkRouteAttr,
) net.Addr {
	var address []byte
	var local []byte
	for _, attribute := range attributes {
		switch attribute.Attr.Type {
		case syscall.IFA_ADDRESS:
			address = attribute.Value
		case syscall.IFA_LOCAL:
			local = attribute.Value
		}
	}
	if len(local) > 0 {
		address = local
	}

	switch message.Family {
	case syscall.AF_INET:
		if len(address) < net.IPv4len {
			return nil
		}
		return &net.IPNet{
			IP:   net.IPv4(address[0], address[1], address[2], address[3]),
			Mask: net.CIDRMask(int(message.Prefixlen), net.IPv4len*8),
		}
	case syscall.AF_INET6:
		if len(address) < net.IPv6len {
			return nil
		}
		ip := make(net.IP, net.IPv6len)
		copy(ip, address[:net.IPv6len])
		return &net.IPNet{
			IP:   ip,
			Mask: net.CIDRMask(int(message.Prefixlen), net.IPv6len*8),
		}
	default:
		return nil
	}
}

func androidNetlinkRIB(messageType, family int) ([]byte, error) {
	fd, err := syscall.Socket(
		syscall.AF_NETLINK,
		syscall.SOCK_RAW|syscall.SOCK_CLOEXEC,
		syscall.NETLINK_ROUTE,
	)
	if err != nil {
		return nil, err
	}
	defer syscall.Close(fd)

	const sequence = 1
	requestLength := syscall.NLMSG_HDRLEN + syscall.SizeofRtGenmsg
	request := make([]byte, requestLength)
	header := (*syscall.NlMsghdr)(unsafe.Pointer(&request[0]))
	header.Len = uint32(requestLength)
	header.Type = uint16(messageType)
	header.Flags = syscall.NLM_F_DUMP | syscall.NLM_F_REQUEST
	header.Seq = sequence
	request[syscall.NLMSG_HDRLEN] = byte(family)

	// Intentionally do not Bind: Android 11+ rejects bind on NETLINK_ROUTE for
	// ordinary applications, but auto-binding during Sendto remains permitted.
	peer := &syscall.SockaddrNetlink{Family: syscall.AF_NETLINK}
	if err := syscall.Sendto(fd, request, 0, peer); err != nil {
		return nil, err
	}
	localAddress, err := syscall.Getsockname(fd)
	if err != nil {
		return nil, err
	}
	local, ok := localAddress.(*syscall.SockaddrNetlink)
	if !ok {
		return nil, syscall.EINVAL
	}

	var result []byte
	for {
		buffer := make([]byte, 64<<10)
		bytesRead, _, err := syscall.Recvfrom(fd, buffer, 0)
		if err != nil {
			return nil, err
		}
		if bytesRead < syscall.NLMSG_HDRLEN {
			return nil, syscall.EINVAL
		}
		chunk := buffer[:bytesRead]
		messages, err := syscall.ParseNetlinkMessage(chunk)
		if err != nil {
			return nil, err
		}
		result = append(result, chunk...)

		for _, message := range messages {
			if message.Header.Seq != sequence || message.Header.Pid != local.Pid {
				return nil, fmt.Errorf("unexpected netlink response")
			}
			switch message.Header.Type {
			case syscall.NLMSG_DONE:
				return result, nil
			case syscall.NLMSG_ERROR:
				return nil, syscall.EINVAL
			}
		}
	}
}
