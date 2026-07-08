# NetLab — User Guide

This guide walks through building and running your first network topology in NetLab. It assumes NetLab is installed and Docker is running (see the [README](../README.md) for installation).

## Table of contents

- [The basic idea](#the-basic-idea)
- [The main window](#the-main-window)
- [Creating your first two nodes](#creating-your-first-two-nodes)
- [Creating a link and wiring it up](#creating-a-link-and-wiring-it-up)
- [Starting nodes and opening a terminal](#starting-nodes-and-opening-a-terminal)
- [Configuring IP addresses](#configuring-ip-addresses)
- [Making a config survive a restart](#making-a-config-survive-a-restart)
- [Building a switch](#building-a-switch)
- [Internet-facing nodes (WAN)](#internet-facing-nodes-wan)
- [Choosing a base image](#choosing-a-base-image)
- [Resource limits](#resource-limits)
- [Resizing panels](#resizing-panels)
- [Language](#language)
- [Troubleshooting](#troubleshooting)

## The basic idea

NetLab has two kinds of building blocks:

- **Nodes** — each one is a real Docker container. When you "attach" to a node, you get your operating system's actual terminal, connected to that container's shell. Nothing about the networking inside a node is simulated.
- **Links** — each one is a real Docker network. A link is like a network cable: it connects at most **two** nodes at a time.

NetLab's job stops at wiring things together and giving you a shell. Configuring IP addresses, routes, bridges, NAT, firewall rules — all of that you do by hand, inside the node, with standard Linux networking tools (`ip`, `iptables`, and friends), exactly as you would on real hardware.

## The main window

- **Left sidebar**: node list on top, link list below. The bar between them (and the one on the sidebar's right edge) can be dragged to resize.
- **Canvas**: the topology graph. Click a node to open its detail view (image, interfaces, live network state); click the back button to return to the graph.
- **Toolbar**: create/edit/delete a node, start/stop it, attach a terminal to it.

## Creating your first two nodes

1. Click **Create** in the toolbar.
2. Give the node a name (e.g. `pc1`) and pick a base image (Alpine, Debian, or Ubuntu — see [Choosing a base image](#choosing-a-base-image)).
3. Click **Add interface** to add a network interface (it's named automatically, e.g. `eth0` — interface names aren't editable, NetLab assigns them by convention so they can never collide).
4. Leave the link dropdown empty for now (you don't have a link yet) and click **Create node**.
5. Repeat for a second node, `pc2`.

## Creating a link and wiring it up

1. In the sidebar, click the **+** next to "LINK", type a name (e.g. `cable1`), confirm.
2. Open `pc1` for editing, set its interface's link to `cable1`, save.
3. Do the same for `pc2`'s interface.

A link can hold at most two nodes — if you try to assign a third, NetLab blocks it (the interface dropdown simply won't offer a full link as an option, except for the interface it's already assigned to).

## Starting nodes and opening a terminal

1. Select a node and click **Start**. This creates (or restarts) its container and attaches its interfaces to the right Docker networks.
2. With the node selected and running, click **Attach**. This opens your operating system's native terminal (Terminal.app, cmd.exe, gnome-terminal/konsole/xterm — whichever is available), already connected to the container's shell via `docker exec`. It's a completely independent process — closing NetLab doesn't close it, and NetLab doesn't log or intercept anything you type.

## Configuring IP addresses

Inside a node's terminal, configure the interface like you would on any Linux box:

```sh
ip addr add 10.0.0.1/24 dev eth0
ip link set eth0 up
```

On the other node:

```sh
ip addr add 10.0.0.2/24 dev eth0
ip link set eth0 up
```

Test connectivity:

```sh
ping -c 4 10.0.0.2
```

## Making a config survive a restart

Stopping a node destroys its network namespace — any interface configuration you set with `ip addr add` is gone the next time it starts, exactly like a real machine losing power. Retyping it every time gets old fast.

If instead you write the configuration into `/etc/network/interfaces` (the standard Debian/Ubuntu networking config file — Alpine uses the same file with `ifupdown`), NetLab **automatically reapplies it** every time the node starts (`ifdown`/`ifup` on each configured interface). Example `/etc/network/interfaces`:

```
auto eth0
iface eth0 inet static
    address 10.0.0.1/24
```

Write that once, and from then on the node comes up already configured, every time.

## Building a switch

To make a node behave like a real L2 switch, bridge two of its interfaces together by hand, inside its terminal:

```sh
ip link add br0 type bridge
ip link set eth0 master br0
ip link set eth1 master br0
ip link set eth0 up
ip link set eth1 up
ip link set br0 up
```

Don't put an IP address on `eth0`/`eth1` — a switch operates at layer 2, it doesn't need one. If you want to reach the switch itself (e.g. to `ping` or `ssh` into it), put an IP on `br0` instead.

Before starting this node, open it for editing and turn on the **"Switch node"** toggle. This matters: Docker Desktop (on Windows and macOS) enables an option called *hairpin mode* on its virtual network ports, and that setting turns a perfectly ordinary two-port bridge into a broadcast loop. The toggle tells NetLab to disable hairpin mode on this node's ports every time it starts — the fix is applied automatically, you don't need to do anything else. On Linux this toggle is a no-op (hairpin is already off there by default), so it's always safe to leave it on for any node you're using as a switch/bridge.

## Internet-facing nodes (WAN)

If an exercise needs a node with actual internet access, open it for editing, turn on **Internet access**, and (optionally) set a custom name for the WAN interface (default `eth_wan`). NetLab gives that interface an IP automatically via a dedicated NAT'd Docker network — think of it as an ISP handing you an uplink.

You still have to do the actual routing work yourself, inside the node:

```sh
echo 1 > /proc/sys/net/ipv4/ip_forward
iptables -t nat -A POSTROUTING -o eth_wan -j MASQUERADE
```

And on any node that should reach the internet through this one, add a default route pointing at it.

## Choosing a base image

Alpine, Debian, and Ubuntu are all available, and all three ship the same network toolset: `iproute2`, `iptables`, `bridge-utils`, `tcpdump`, `ethtool`, `iputils-ping`, DNS tools, plus `curl`, `wget`, `vim`, `nano`, `traceroute`. Pick whichever distribution's conventions you want to practice with — the networking exercises work identically on all three.

## Resource limits

By default, a node has no CPU/RAM limit — it can use as much as the host has available. If you need to cap it (e.g. to simulate a constrained device, or to keep many nodes running without exhausting your machine), open the node for editing, expand **Advanced**, and tick the RAM and/or CPU checkboxes to set a limit.

## Resizing panels

The line between the node list and the link list, and the sidebar's right edge, are both draggable — hover over them (the cursor changes) and drag to resize.

## Language

Click the language toggle in the top-right corner of the toolbar to switch between Italian and English at any time.

## Troubleshooting

- **"Docker isn't running"** — start Docker Desktop (Windows/macOS) or `sudo systemctl start docker` (Linux), then retry.
- **A link's Docker network disappeared** (e.g. someone ran `docker network rm` by hand) — just start the node again; NetLab detects the missing network and recreates it automatically.
- **A custom image (Alpine/Debian/Ubuntu) is missing** — same story: NetLab rebuilds it automatically the next time you start a node that needs it. The very first rebuild takes a little longer.
- **"A container with this name already exists"** — usually means a leftover container from a previous crash/manual `docker` command. If it's one NetLab created and isn't in use by another node, NetLab removes it and retries automatically; if the message persists, check `docker ps -a` for a stray container with that name.
- **A link can't be deleted** — it's still assigned to at least one node's interface (the delete button is disabled with a tooltip explaining this). Remove the interface assignment first.
