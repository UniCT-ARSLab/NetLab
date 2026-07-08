import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { docker } from './docker.client';
import { DbService } from './db.service';
import { NodeService } from './node.service';
import { logger } from '../../electron/logger';
import { LabLink } from '../models/link.model';
import { AppError } from '../models/app-error';

const NSENTER_HELPER_IMAGE = 'netlab-nsenter-helper:v2';
const NSENTER_HELPER_DOCKERFILE = 'FROM alpine:3.20\nRUN apk add --no-cache util-linux iproute2\nENTRYPOINT ["nsenter"]\n';

let links = new Map<string, LabLink>();
let fallbackTunnelsPromise: Promise<void> | null = null;

async function ensureNsenterHelperImage(): Promise<void> {
  try {
    await docker.getImage(NSENTER_HELPER_IMAGE).inspect();
  } catch {
    const contextPath = fs.mkdtempSync(path.join(os.tmpdir(), 'netlab-nsenter-'));
    fs.writeFileSync(path.join(contextPath, 'Dockerfile'), NSENTER_HELPER_DOCKERFILE);
    const stream = await docker.buildImage(
      { context: contextPath, src: ['Dockerfile'] },
      { t: NSENTER_HELPER_IMAGE }
    );
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err: Error | null) => err ? reject(err) : resolve());
    });
    fs.rmSync(contextPath, { recursive: true, force: true });
  }
}

function demuxExecOutput(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on('end', () => {
      const raw = Buffer.concat(chunks);
      let text = '';
      let i = 0;
      while (i + 8 <= raw.length) {
        const size = raw.readUInt32BE(i + 4);
        const end  = i + 8 + size;
        if (end > raw.length) break;
        text += raw.subarray(i + 8, end).toString('utf8');
        i = end;
      }
      resolve(text);
    });
    stream.on('error', reject);
  });
}

async function execCapture(container: ReturnType<typeof docker.getContainer>, cmd: string): Promise<string> {
  const exec = await container.exec({ Cmd: ['sh', '-c', cmd], AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: false });
  return demuxExecOutput(stream);
}

async function createDockerNetwork(name: string): Promise<{ id: string }> {
  return docker.createNetwork({
    Name: `netlab_${name}`,
    Driver: 'bridge',
    Options: {
      'com.docker.network.bridge.enable_icc': 'true',
      'com.docker.network.bridge.enable_ip_masquerade': 'false',
    },
    IPAM: { Driver: 'default', Config: [] },
  });
}

function persist(): void {
  // runtime only
  const toSave = Array.from(links.values()).map(l => ({
    ...l,
    connectedNodes: [],
  }));
  DbService.persistLinks(toSave);
}

export const NetworkService = {

  init(): void {
    links = new Map(DbService.getLinks().map(l => [l.name, l]));
  },

  // check docker networks that starts with 'netlab_'
  // import them if they aren't in the db
  async reconcile(): Promise<void> {
    let changed = false;
    const dockerNetworks = await docker.listNetworks();
    const netlabNets = dockerNetworks.filter(n => n.Name?.startsWith('netlab_') && !n.Name.startsWith('netlab_wan_'));

    // Import orphaned Docker networks; re-associate if ID changed (e.g. Docker Desktop restart)
    for (const net of netlabNets) {
      const linkName = net.Name!.slice('netlab_'.length);
      if (!links.has(linkName)) {
        links.set(linkName, { name: linkName, dockerNetworkId: net.Id, connectedNodes: [] });
        changed = true;
      } else {
        const existing = links.get(linkName)!;
        if (existing.dockerNetworkId !== net.Id) {
          existing.dockerNetworkId = net.Id;
          changed = true;
        }
      }
    }

    // delete networks that are in the db but not in the docker network list
    for (const [, link] of links) {
      if (link.dockerNetworkId) {
        const exists = netlabNets.some(n => n.Id === link.dockerNetworkId);
        if (!exists) {
          link.dockerNetworkId = undefined;
          changed = true;
        }
      }
    }

    if (changed) persist();
  },

  // networks listing
  list(): LabLink[] {
    const allNodes = NodeService.list();
    return Array.from(links.values()).map(link => ({
      ...link,
      connectedNodes: allNodes
        .filter(n => n.interfaces.some(i => i.linkName === link.name))
        .map(n => n.id),
    }));
  },

  async createLink(name: string): Promise<LabLink> {
    if (links.has(name)) throw new AppError('LINK_ALREADY_EXISTS', { name });

    const network = await createDockerNetwork(name);

    const link: LabLink = { name, dockerNetworkId: network.id, connectedNodes: [] };
    links.set(name, link);
    persist();
    return link;
  },

  // Cached so every caller (startup + every docker:check) awaits the same
  // run instead of racing node creation against it.
  ensureFallbackTunnelsDisabled(): Promise<void> {
    if (process.platform !== 'darwin') return Promise.resolve();
    if (!fallbackTunnelsPromise) {
      fallbackTunnelsPromise = NetworkService.disableFallbackTunnels().catch(e => {
        logger.warn('disableFallbackTunnels fallita:', e);
      });
    }
    return fallbackTunnelsPromise;
  },

  async disableFallbackTunnels(): Promise<void> {
    await ensureNsenterHelperImage();
    const container = await docker.createContainer({
      Image: NSENTER_HELPER_IMAGE,
      Entrypoint: ['nsenter'],
      Cmd: ['-t', '1', '-n', '--', 'sh', '-c',
        'echo 1 > /proc/sys/net/core/fb_tunnels_only_for_init_net; cat /proc/sys/net/core/fb_tunnels_only_for_init_net'],
      HostConfig: { Privileged: true, PidMode: 'host', AutoRemove: true },
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    await container.start();
    const { StatusCode } = await container.wait();
    logger.info(`[disableFallbackTunnels] exit=${StatusCode} output=${Buffer.concat(chunks).toString('utf8').trim()}`);
  },

  // An interface with no link assigned has no Docker network to join, so we
  // give it a dummy interface just so it still shows up in "ip a" (a NIC
  // with the cable unplugged), inert in every practical sense. If the
  // student later assigns a link, attachInterface finds that name already
  // taken and handles it with the same mechanism used for rename conflicts
  // (bumps the occupant to eth_tmp).
  async createDummyInterface(nodeId: string, ifaceName: string): Promise<void> {
    const node = NodeService.get(nodeId);
    if (!node?.containerId) return;
    const container = docker.getContainer(node.containerId);
    const exec = await container.exec({
      Cmd: ['sh', '-c', `
        ip link add "${ifaceName}" type dummy 2>/dev/null || true
        ip link set "${ifaceName}" up 2>/dev/null || true
      `],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve) => {
      stream.resume();
      stream.on('end', resolve);
      stream.on('error', (e: Error) => { logger.warn('[createDummyInterface exec]', e); resolve(); });
    });
  },

  // renaming of interfaces based on mac identification
  async attachInterface(nodeId: string, ifaceName: string, linkName: string): Promise<void> {
    const node = NodeService.get(nodeId);
    if (!node || !node.containerId) throw new AppError('NODE_NOT_STARTED', { id: nodeId });

    const link = links.get(linkName);
    if (!link?.dockerNetworkId) throw new AppError('LINK_NOT_FOUND', { name: linkName });

    let network = docker.getNetwork(link.dockerNetworkId);

    // If someone deleted the Docker network from outside the app (e.g. via
    // terminal) between one start and the next, recreate it on the fly
    // instead of failing in a loop forever: it's a resource we own,
    // reproducible identically (same name, same options).
    let netInfo;
    try {
      netInfo = await network.inspect();
    } catch (e: any) {
      if (e?.statusCode !== 404) throw e;
      logger.warn(`[attachInterface] rete Docker del link "${linkName}" non trovata (cancellata da fuori l'app?), la ricreo`);
      const recreated = await createDockerNetwork(linkName);
      link.dockerNetworkId = recreated.id;
      persist();
      network = docker.getNetwork(recreated.id);
      netInfo = await network.inspect();
    }
    const alreadyConnected = !!(netInfo.Containers?.[node.containerId]);

    if (!alreadyConnected) {
      const othersConnected = Object.keys(netInfo.Containers ?? {}).length;
      if (othersConnected >= 2) {
        throw new AppError('LINK_AT_CAPACITY', { name: linkName });
      }
      try {
        await network.connect({ Container: node.containerId });
      } catch (e: any) {
        if (e?.statusCode !== 409) throw e;
      }
      netInfo = await network.inspect();
    }

    const mac      = netInfo.Containers?.[node.containerId]?.MacAddress ?? '';
    const dockerIp = netInfo.Containers?.[node.containerId]?.IPv4Address ?? '';

    const container = docker.getContainer(node.containerId);
    const exec = await container.exec({
      Cmd: ['sh', '-c', `
        mac="${mac}"
        target="${ifaceName}"
        docker_ip="${dockerIp}"
        if ip link show "$target" > /dev/null 2>&1; then
          cur=$(cat /sys/class/net/$target/address 2>/dev/null || true)
          if [ "$cur" = "$mac" ]; then
            ip link set "$target" up
            [ -n "$docker_ip" ] && ip addr del "$docker_ip" dev "$target" 2>/dev/null || true
            exit 0
          fi
          ip link set "$target" down 2>/dev/null || true
          ip link set "$target" name "eth_tmp" 2>/dev/null || true
        fi
        i=0
        while [ $i -lt 20 ]; do
          for f in /sys/class/net/eth*; do
            [ -e "$f" ] || continue
            cur=$(cat "$f/address" 2>/dev/null || true)
            if [ "$cur" = "$mac" ]; then
              name=$(basename "$f")
              if [ "$name" != "$target" ]; then
                ip link set "$name" down
                ip link set "$name" name "$target"
              fi
              ip link set "$target" up
              [ -n "$docker_ip" ] && ip addr del "$docker_ip" dev "$target" 2>/dev/null || true
              exit 0
            fi
          done
          i=$((i+1))
          sleep 0.1
        done
        echo "WARN: $target not found via MAC $mac" >&2
      `],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve) => {
      stream.resume();
      stream.on('end', resolve);
      stream.on('error', (e: Error) => { logger.warn('[attachInterface exec]', e); resolve(); });
    });
  },

  // Docker Desktop (macOS/Windows) doesn't use docker-proxy, so it enables
  // hairpin mode on its bridges' veths. On a node acting as an L2 bridge
  // between two Docker networks, this turns normal flooding into an
  // infinite loop: every host-level bridge reflects back on the same port
  // the frames the container just forwarded out the other one. We disable
  // hairpin on the node's interfaces' host-side veths after every start
  // (veths change on every container restart, so this has to be redone
  // each time). On native Linux hairpin is already off by default: this is
  // a harmless no-op there.
  async disableHairpinForSwitch(nodeId: string): Promise<void> {
    const node = NodeService.get(nodeId);
    if (!node?.containerId) return;
    const container = docker.getContainer(node.containerId);

    for (const iface of node.interfaces) {
      if (!iface.linkName) continue;
      try {
        const peerIdx = (await execCapture(container, `cat /sys/class/net/${iface.name}/iflink 2>/dev/null`)).trim();
        if (!peerIdx || !/^\d+$/.test(peerIdx)) continue;

        await ensureNsenterHelperImage();
        const helper = await docker.createContainer({
          Image: NSENTER_HELPER_IMAGE,
          Entrypoint: ['nsenter'],
          Cmd: ['-t', '1', '-n', '--', 'sh', '-c',
            `veth=$(ip -o link show | grep "^${peerIdx}:" | sed -E 's/^[0-9]+: ([^@]+)@.*/\\1/'); [ -n "$veth" ] && bridge link set dev "$veth" hairpin off || true`],
          HostConfig: { Privileged: true, PidMode: 'host', AutoRemove: true },
          AttachStdout: true,
          AttachStderr: true,
        });
        const stream = await helper.attach({ stream: true, stdout: true, stderr: true });
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        await helper.start();
        const { StatusCode } = await helper.wait();
        logger.info(`[disableHairpinForSwitch] iface=${iface.name} peerIdx=${peerIdx} exit=${StatusCode} output=${Buffer.concat(chunks).toString('utf8').trim()}`);
      } catch (e) {
        logger.warn(`[disableHairpinForSwitch] iface ${iface.name} fallita:`, e);
      }
    }
  },

  async applyInterfacesConfig(nodeId: string, ifaceNames: string[]): Promise<void> {
    const node = NodeService.get(nodeId);
    if (!node?.containerId || ifaceNames.length === 0) return;
    const container = docker.getContainer(node.containerId);
    const script = ifaceNames
      .map(n => `ifdown "${n}" 2>/dev/null || true; ifup "${n}" 2>/dev/null || true`)
      .join('\n');
    const exec = await container.exec({
      Cmd: ['sh', '-c', script],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve) => {
      stream.resume();
      stream.on('end', resolve);
      stream.on('error', () => resolve());
    });
  },


  // nat bridge for internet, sort of dhcp
  async createWanBridge(nodeId: string, wanIfaceName: string): Promise<void> {
    const node = NodeService.get(nodeId);
    if (!node?.containerId) throw new AppError('NODE_HAS_NO_CONTAINER', { id: nodeId });

    const networkName = `netlab_wan_${nodeId}`;

    let network: ReturnType<typeof docker.getNetwork>;

    const existing = await docker.listNetworks({ filters: { name: [networkName] } });
    const found = existing.find(n => n.Name === networkName);

    if (found) {
      network = docker.getNetwork(found.Id);
    } else {
      network = await docker.createNetwork({
        Name: networkName,
        Driver: 'bridge',
        Options: {
          'com.docker.network.bridge.enable_icc': 'true',
          'com.docker.network.bridge.enable_ip_masquerade': 'true',
        },
      });
    }

    try {
      await network.connect({ Container: node.containerId });
    } catch (e: any) {
      const msg = String((e as any)?.message ?? '').toLowerCase();
      if (e?.statusCode !== 409 && !msg.includes('already exists')) throw e;
    }

    const container = docker.getContainer(node.containerId);
    const containerInfo = await container.inspect();
    const netInfo = containerInfo.NetworkSettings?.Networks?.[networkName];
    const mac      = netInfo?.MacAddress ?? '';
    const gateway  = netInfo?.Gateway ?? '';

    const exec = await container.exec({
      Cmd: ['sh', '-c', `
        mac="${mac}"
        gateway="${gateway}"
        i=0
        while [ $i -lt 5 ]; do
          for f in /sys/class/net/eth*; do
            [ -e "$f" ] || continue
            cur=$(cat "$f/address" 2>/dev/null)
            if [ "$cur" = "$mac" ]; then
              name=$(basename "$f")
              ip link set "$name" down
              ip link set "$name" name "${wanIfaceName}"
              ip link set "${wanIfaceName}" up
              [ -n "$gateway" ] && ip route add default via "$gateway" dev "${wanIfaceName}" 2>/dev/null || true
              exit 0
            fi
          done
          i=$((i+1))
          sleep 0.1
        done
        echo "WARN: ${wanIfaceName} not found via MAC $mac" >&2
      `],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve) => {
      stream.resume();
      stream.on('end', resolve);
      stream.on('error', (e: Error) => { logger.warn('[createWanBridge exec]', e); resolve(); });
    });
  },

  async deleteWanBridge(nodeId: string): Promise<void> {
    const networkName = `netlab_wan_${nodeId}`;
    try {
      const existing = await docker.listNetworks({ filters: { name: [networkName] } });
      const node = NodeService.get(nodeId);
      for (const net of existing) {
        if (net.Name === networkName) {
          const network = docker.getNetwork(net.Id);
          if (node?.containerId) {
            try { await network.disconnect({ Container: node.containerId, Force: true }); } catch { /* already disconnected */ }
          }
          try { await network.remove(); } catch { /* already removed */ }
        }
      }
    } catch { /* ignore */ }
  },

  async deleteLink(name: string): Promise<void> {
    const link = links.get(name);
    if (!link) throw new AppError('LINK_NOT_FOUND', { name });

    const usedBy = NodeService.list().filter(n => n.interfaces.some(i => i.linkName === name));
    if (usedBy.length > 0) {
      const nodeNames = usedBy.map(n => n.name).join(', ');
      throw new AppError('LINK_IN_USE', { name, nodeNames });
    }

    if (link.dockerNetworkId) {
      try {
        await docker.getNetwork(link.dockerNetworkId).remove();
      } catch (e: any) {
        if (e?.statusCode !== 404) throw e;
      }
    }

    links.delete(name);
    persist();
  },
};