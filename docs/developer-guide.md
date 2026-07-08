# NetLab — Developer Guide

This document describes how NetLab is built, why some of its less obvious decisions exist, and how to work on it.

## Table of contents

- [Architecture overview](#architecture-overview)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Running locally](#running-locally)
- [Data model](#data-model)
- [How a node maps to Docker](#how-a-node-maps-to-docker)
- [How a link maps to Docker](#how-a-link-maps-to-docker)
- [Custom images](#custom-images)
- [The switch / hairpin-mode fix](#the-switch--hairpin-mode-fix)
- [Self-healing Docker resources](#self-healing-docker-resources)
- [Error handling and localization](#error-handling-and-localization)
- [IPC surface](#ipc-surface)
- [The native terminal](#the-native-terminal)
- [Icon assets](#icon-assets)

## Architecture overview

NetLab is an Electron app with two processes:

- **Main process** (`electron/`, Node.js) — owns all Docker access via [dockerode](https://github.com/apocas/dockerode), the app's persisted state, and everything platform-specific (native terminal launching, window chrome). Nothing here can be seen or reached directly by the renderer.
- **Renderer process** (`frontend/`, Angular + PrimeNG) — the UI. It never talks to Docker directly; every action goes through `window.electronAPI`, a small surface exposed by `electron/preload.ts` via `contextBridge` (context isolation is on, `nodeIntegration` is off).

```
Angular components  →  window.electronAPI.*  →  ipcRenderer.invoke  →  ipcMain.handle (electron/ipc-handlers.ts)
                                                                              │
                                                                              ▼
                                                              backend/services/*.service.ts  →  dockerode  →  Docker
```

`backend/` is plain TypeScript with no Electron or Angular dependency — it's the domain logic (nodes, links, Docker orchestration), imported by `electron/ipc-handlers.ts`. It's structured this way so the domain logic doesn't know or care that it's running inside Electron.

## Tech stack

- **Electron**
- **Angular** (standalone components, signals) + **PrimeNG** (Aura theme)
- **dockerode**
- **ngx-translate**
- **electron-builder**

## Project structure

```
backend/
  models/          domain types (LabNode, LabLink, AppError, IPC channel names)
  services/        node.service.ts, network.service.ts, db.service.ts, docker.client.ts
electron/
  main.ts          app lifecycle, window creation, startup reconciliation
  ipc-handlers.ts  ipcMain.handle(...) for every channel, native terminal launching
  preload.ts       contextBridge surface, strips Electron's IPC error prefix
frontend/src/app/
  components/      one folder per UI component (main-layout is the root shell)
  services/        thin Angular wrappers around window.electronAPI, exposed as Observables
  i18n/            it.ts / en.ts translation tables
  shared/          small cross-component helpers (image-options.ts, app-error.ts)
docs/              this file, and the user guide
build/             app icon sources and generated icon.ico/.icns/.png
.github/workflows/ release.yml — CI build + publish on tag push
```

## Running locally

```sh
npm install
cd frontend && npm install && cd ..
npm run dev
```

This runs the Angular dev server, a `tsc --watch` for the backend/electron TypeScript, and Electron pointed at `http://localhost:4200`, concurrently. Requires Docker running locally.

## Data model

- **`LabNode`** (`backend/models/node.model.ts`) — id, name, image, status, `NetworkInterface[]` (each with a name and an optional `linkName`), optional CPU/RAM limits, mounts, `internetFacing`/`wanIfaceName`, `isSwitch`.
- **`LabLink`** (`backend/models/link.model.ts`) — name, the Docker network id backing it, and a computed `connectedNodes` (derived at read time from which nodes currently have an interface pointing at this link — not stored).
- Interface **names are not user-editable** — the form assigns `eth0`, `eth1`, … automatically, picking the lowest name not already in use, so removing and re-adding an interface can never produce a duplicate.

Persistence is a flat JSON store (`backend/services/db.service.ts`), not a database — this is a single-user desktop app, there's no concurrent-write concern to design around.

## How a node maps to Docker

`NodeService.start()` (`backend/services/node.service.ts`):

1. Reuses the existing container if one is already tracked and still exists; otherwise creates one (`Privileged: true`, `Tty: true`, `OpenStdin: true`, no `StdinOnce`). That Tty/OpenStdin combination — a pty attached with stdin left open indefinitely — is what keeps a plain `sh`/`bash` CMD container alive without needing a custom entrypoint or a `sleep infinity` hack; it works identically regardless of which base image is picked.
2. Immediately disconnects the container from Docker's default `bridge` network. This has to happen **after** `container.start()`, not before — Docker only actually attaches the default network once the container starts, so disconnecting earlier is a silent no-op.
3. If container creation fails with a 409 name conflict, checks whether the conflicting container is a NetLab-managed orphan not tracked by any other node (via the `netlab.managed` label) and, if so, removes it and retries once — see [Self-healing Docker resources](#self-healing-docker-resources).

Then, per interface (`electron/ipc-handlers.ts`, `NODE_START` handler):

- No link assigned → `NetworkService.createDummyInterface()` adds a `dummy`-type interface, purely so it shows up in `ip a` as a disconnected NIC.
- Link assigned → `NetworkService.attachInterface()` connects the container to that link's Docker network, then execs into the container and **renames the interface by matching its MAC address** (the veth Docker just created has a MAC only known after `network.connect()` resolves) to the name the student configured. This MAC-based matching, not connection order, is what makes it safe to run reconnects/switch nodes without ambiguity about which physical interface is which.
- `NetworkService.applyInterfacesConfig()` then runs `ifdown`/`ifup` on every configured interface — this is what makes a student's `/etc/network/interfaces` config survive a restart (see the user guide).

## How a link maps to Docker

A link is a Docker bridge network named `netlab_<link-name>`, created with `enable_icc: true` and no IPAM config (students assign IPs by hand, Docker's own address management would only get in the way). `attachInterface` refuses a third node on a link that already has two (`LINK_AT_CAPACITY`).

## Custom images

Alpine, Debian, and Ubuntu are not pulled from a public registry — they're built locally (`backend/services/node.service.ts`, `CUSTOM_IMAGES`) from a Dockerfile embedded as a string, layering the same network toolset on top of each base. They're built once at app startup (`NodeService.ensureCustomImagesBuilt()`, called from `electron/main.ts`) so a student is never stuck waiting mid-exercise, and are rebuilt on demand if missing (see below).

## The switch / hairpin-mode fix

The one piece of behavior in this codebase that isn't obvious from reading the code alone, so it's worth writing down properly.

**The problem.** A student building a switch bridges two of a node's interfaces (`ip link add br0 type bridge`, `ip link set ethN master br0`). On Docker Desktop (Windows and macOS — **not** Linux with native Docker Engine), this produced an infinite L2 broadcast storm and 100% packet loss, even though the bridge itself was topologically correct (two ports, no redundancy, nothing that should be able to loop).

**Root cause.** Docker Desktop doesn't use `docker-proxy` for port publishing (unlike Docker Engine on Linux, which does by default), so it enables *hairpin mode* on the veth ports of its own bridge networks. A port in hairpin mode reflects flooded frames back out the same port they arrived on. With a container bridging two Docker networks, that turns a normal ARP/broadcast flood into: frame enters the container on port A → gets forwarded to port B → the *host-level* Docker bridge for that network reflects it straight back into port B → the container's own bridge forwards it back out port A → repeat forever. The container's bridge is innocent; the loop closes on the host-level bridges outside anything the container/student can see or configure.

**The fix.** `NetworkService.disableHairpinForSwitch()` (`backend/services/network.service.ts`), run automatically at every start of a node with `isSwitch: true`:

1. For each of the node's interfaces, reads `/sys/class/net/<iface>/iflink` inside the container — this is the ifindex of the veth's *peer*, i.e. the host-side end.
2. Spawns a privileged helper container (`netlab-nsenter-helper`, a minimal Alpine image with only `nsenter` + `iproute2`) using `nsenter -t 1 -n` to reach the **real host's** (or, on Docker Desktop, the VM's) network namespace — not the calling container's.
3. Inside that namespace, resolves the veth name from the ifindex and runs `bridge link set dev <veth> hairpin off`.

This has to be redone on every start, since Docker creates fresh veths (new names, new ifindexes) every time a container (re)connects to a network. On native Linux this is a harmless no-op (hairpin is already off by default there), so the toggle is always safe to leave on.

## Self-healing Docker resources

Three categories of "a resource NetLab owns got deleted or is missing" are handled the same way — detect on next use, recreate transparently, log it, and don't bother the user with an error if it succeeds:

- **A link's Docker network** deleted externally (`docker network rm`) → `attachInterface` catches the 404 on inspect, recreates the network with the same name/options, updates and persists the new id.
- **A custom image** deleted externally (`docker image prune`, manual `docker rmi`) → `ensureImagePresent` rebuilds it instead of attempting a `docker pull` (which would fail — these images don't exist on any registry).
- **An orphaned same-named container** (state file wiped/corrupted while a container with that name still exists) → `removeOrphanedContainerByName` removes it, but only if it carries the `netlab.managed` label *and* isn't tracked by a different active node, then the caller retries creation once.

## Error handling and localization

Backend code (`electron/`, `backend/`) has no access to `ngx-translate` — that only exists in the Angular renderer. Hardcoding Italian (or English) strings in thrown errors would make them impossible to localize from the frontend. Instead:

- `backend/models/app-error.ts` defines `AppError`, a typed `{ code, params }` pair, JSON-encoded into `Error.message` (the only part of a thrown error Electron's IPC reliably preserves across the renderer boundary — custom properties don't survive the trip).
- `electron/ipc-handlers.ts`'s `toUserError()` classifies raw Docker/system errors it doesn't already recognize as an `AppError` into one, by pattern-matching the Docker daemon's own error text (e.g. `"no such image"` → `IMAGE_NOT_FOUND`).
- `electron/preload.ts` strips Electron's own `"Error invoking remote method '<channel>': "` prefix before the error ever reaches application code — this is the one place that raw wrapper text is visible, so it's the only place that can clean it.
- `frontend/src/app/shared/app-error.ts` parses the JSON back out and looks up `errors.<code>` in `it.ts`/`en.ts`, interpolating `params`.

**Adding a new error**: add the code to `ERROR_CODES` in `backend/models/app-error.ts`, `throw new AppError('YOUR_CODE', { ...params })` wherever it happens, then add the `errors.YOUR_CODE` translation key (with `{{param}}` placeholders) to both `it.ts` and `en.ts`. Nothing else needs to change — every error dialog in the app already routes through `translateAppError()`.

Blocking errors are shown via `ConfirmationService.confirm()` (a modal the user dismisses explicitly), not `MessageService.add()` toasts — a toast that auto-dismisses after a few seconds is the wrong affordance for "this action failed and here's why." Where a failure mode is common and predictable (duplicate name, a link still in use), the UI validates client-side and gives inline feedback *before* even calling the backend, rather than round-tripping to get an error back — see `nameError`/`triggerNameError()` in `node-form.component.ts` and `link-list.component.ts` for the pattern (a transient CSS class toggled via direct DOM manipulation + forced reflow, not an Angular class binding, so the shake animation reliably replays on every attempt regardless of whether it's triggered by a click or an Enter keypress).

## IPC surface

Channel names live in one place, `backend/models/ipc.model.ts` (`IPC_CHANNELS`), imported by both `electron/preload.ts` and `electron/ipc-handlers.ts` so they can't drift apart. `preload.ts` exposes a narrow, purpose-built API (`window.electronAPI.createNode(...)`, not a generic "invoke any channel") — the renderer never sees a raw `ipcRenderer`.

## The native terminal

There's no embedded terminal emulator (no xterm.js, no node-pty) — "Attach" launches the OS's own terminal (`electron/ipc-handlers.ts`, `openNativeTerminal`), connected via a plain `docker exec -it <container> sh -c "..."` command, platform-specific:

- **macOS**: AppleScript driving Terminal.app, with a custom tab title.
- **Windows**: a temp `.bat` file (avoids fighting `cmd.exe`'s quoting rules when nesting `start` + `docker exec`), with `@echo off`/`cls` so the batch script's own lines aren't echoed into the window.
- **Linux**: tries `gnome-terminal`, `konsole`, `xfce4-terminal`, `xterm`, then `x-terminal-emulator` last (it has no reliable title flag, so it must lose to anything more specific).

One non-obvious detail: the exec command forces `export TERM=screen` before launching the shell. Debian/Ubuntu's default `.bashrc` resets the terminal window title via an OSC-0 escape sequence whenever `$TERM` matches `xterm*`/`rxvt*` — which would immediately clobber the title NetLab just set. `screen` isn't matched by that pattern and still has solid color/terminfo support.

Once launched, the terminal is a fully independent OS process — NetLab doesn't track, log, or manage the session afterward.

## Icon assets

App icons live in `build/` (`icon.ico`, `icon.icns`, `icon.png`, `icons/` for Linux's various sizes), generated from `build/icon-src/icon.html` (an SVG rendered via Playwright, then converted with `sharp`/`png2icons`). To change the icon design, edit `icon.html` and regenerate — there's no npm script for this yet since it's a rare, manual step.
