<p align="center">
  <img src="build/icon-src/icon-1024.png" width="120" alt="NetLab icon">
</p>

<h1 align="center">NetLab</h1>

<p align="center">
  A desktop app for building and experimenting with network topologies using real Docker containers.
</p>

## What is NetLab

NetLab lets students design a network topology visually — nodes, cables, switches — and have each element backed by a real, runnable environment: every node is a Docker container, every cable/link is a real Docker network. Students configure IP addresses, routes, bridges and firewall rules by hand, inside the actual container's shell, exactly as they would on real hardware — NetLab only handles the wiring, not the networking itself.

## Features

- **Visual topology editor** — drag nodes onto a canvas, connect them with links, pan/zoom, resize the layout.
- **Real containers, real shells** — every node opens in your OS's native terminal (not an emulator embedded in the app), attached via `docker exec`.
- **Multiple base images** — Alpine, Debian, and Ubuntu, each pre-loaded with a full network toolset (`iproute2`, `iptables`, `bridge-utils`, `tcpdump`, `ethtool`, and more).
- **Switch nodes** — a node can bridge two links together (`ip link add br0 type bridge`), taught and built by the student; NetLab transparently works around a Docker Desktop quirk (hairpin mode) that would otherwise break it.
- **Internet-facing nodes** — a dedicated WAN bridge with NAT, for exercises that need outbound connectivity while the student still configures `ip_forward`/`iptables MASQUERADE` themselves.
- **Self-healing** — Docker resources NetLab owns (networks, custom images, orphaned containers) are detected and rebuilt automatically if something external interferes with them (e.g. `docker network rm` run by hand).
- **Bilingual UI** — Italian and English, switchable at runtime.

## Requirements

- **Docker** (Docker Desktop on Windows/macOS, or Docker Engine on Linux), installed and running.

## Installation

Download the installer for your platform from the [Releases page](../../releases):

- **Windows** — `NetLab Setup x.y.z.exe`
- **macOS** — `NetLab-x.y.z.dmg`
- **Linux** — `NetLab-x.y.z.AppImage` (self-contained — `chmod +x` it and run it) or `netlab-app_x.y.z_amd64.deb` (install with `sudo apt install ./netlab-app_x.y.z_amd64.deb`)

Make sure Docker is running before you launch NetLab.

NetLab isn't code-signed (that requires a paid certificate), so the OS will warn you the first time you run it — this is the same warning any unsigned app triggers, not something specific to NetLab:

- **Windows**: SmartScreen shows "Windows protected your PC". Click **More info**, then **Run anyway**. If it was blocked silently instead, go to **Settings → Privacy & security → Windows Security → Virus & threat protection → Protection history** to allow it.
- **macOS**: Gatekeeper refuses to open it ("cannot be opened because the developer cannot be verified"). Go to **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to the NetLab message.
- **Linux (AppImage)**: needs `libfuse2` installed (`sudo apt install libfuse2`, or `libfuse2t64` on newer distros) — without it the AppImage fails to mount and won't start. The `.deb` package doesn't have this requirement.

## Getting started

See the [user guide](docs/user-guide.md) for a step-by-step walkthrough of building your first topology.

## Development

See the [developer guide](docs/developer-guide.md) for the project's architecture, how to run it locally, and how to build a release.
