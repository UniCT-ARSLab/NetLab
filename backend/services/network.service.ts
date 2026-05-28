import { docker } from './docker.client';
import { DbService } from './db.service';
import { NodeService } from './node.service';
import { logger } from '../../electron/logger';
import { LabLink } from '../models/link.model';

let links = new Map<string, LabLink>();

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
    const netlabNets = dockerNetworks.filter(n => n.Name?.startsWith('netlab_'));

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
    if (links.has(name)) throw new Error(`Link "${name}" già esistente`);

    const network = await docker.createNetwork({
      Name: `netlab_${name}`,
      Driver: 'bridge',
      Options: {
        'com.docker.network.bridge.enable_icc': 'true',
        'com.docker.network.bridge.enable_ip_masquerade': 'false',
      },
      IPAM: { Driver: 'default', Config: [] },
    });
    // traffic on the same bridge must pass through iptables on Linux 
    // we cannot use Internal=true adds stricter rules that
    // can silently drop packets with non-Docker-assigned source IPs.

    const link: LabLink = { name, dockerNetworkId: network.id, connectedNodes: [] };
    links.set(name, link);
    persist();
    return link;
  },

  // Attaches a running container's interface to a Docker network and renames it
  // it is ok to call even if the container is already connected
  async attachInterface(nodeId: string, ifaceName: string, linkName: string): Promise<void> {
    const node = NodeService.get(nodeId);
    if (!node || !node.containerId) throw new Error(`Nodo ${nodeId} non avviato`);

    const link = links.get(linkName);
    if (!link?.dockerNetworkId) throw new Error(`Link "${linkName}" non trovato`);

    const network = docker.getNetwork(link.dockerNetworkId);

    const netInfo = await network.inspect();
    const alreadyConnected = !!(netInfo.Containers?.[node.containerId]);

    if (!alreadyConnected) {
      const othersConnected = Object.keys(netInfo.Containers ?? {}).length;
      if (othersConnected >= 2) {
        throw new Error(`Link "${linkName}" is already at capacity (max 2 nodes)`);
      }
      await network.connect({ Container: node.containerId });
    }

    const container = docker.getContainer(node.containerId);
    const exec = await container.exec({
      Cmd: ['sh', '-c', `
        i=0
        while [ $i -lt 20 ]; do
          for f in /sys/class/net/eth*; do
            [ -e "$f" ] || continue
            name=$(basename "$f")
            if ! ip link show "${ifaceName}" > /dev/null 2>&1; then
              ip link set "$name" down
              ip link set "$name" name "${ifaceName}"
            fi
            break 2
          done
          i=$((i+1))
          sleep 0.1
        done
        ip link set "${ifaceName}" up 2>/dev/null || true
        ip addr flush dev "${ifaceName}" 2>/dev/null || true
      `],
      AttachStdout: true,
      AttachStderr: true,
    });

    // Wait for the script to actually finish before returning
    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve) => {
      stream.resume(); // drain so the process isn't blocked waiting for stdout to be read
      stream.on('end', resolve);
      stream.on('error', (e: Error) => { logger.warn('[attachInterface exec]', e); resolve(); });
    });
  },

  // flush for docker auto assigned ip
  async flushInterface(nodeId: string, ifaceName: string): Promise<void> {
    const node = NodeService.get(nodeId);
    if (!node?.containerId) return;
    const container = docker.getContainer(node.containerId);
    const exec = await container.exec({
      Cmd: ['sh', '-c', `ip addr flush dev "${ifaceName}" 2>/dev/null || true`],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve) => {
      stream.resume();
      stream.on('end', resolve);
      stream.on('error', (e: Error) => { logger.warn('[flushInterface]', e); resolve(); });
    });
  },

  // Creates a NAT-enabled WAN bridge for an internet-facing node and
  // attaches the container. The new interface inside the container is
  // identified by its MAC address (reported by Docker after connect)
  // and renamed to wanIfaceName so the student knows where to route traffic.
  async createWanBridge(nodeId: string, wanIfaceName: string): Promise<void> {
    const node = NodeService.get(nodeId);
    if (!node?.containerId) throw new Error(`Nodo ${nodeId} non ha un container`);

    const networkName = `netlab_wan_${nodeId}`;

    // Clean up any leftover WAN network from a previous run
    try {
      const existing = await docker.listNetworks({ filters: { name: [networkName] } });
      for (const net of existing) {
        if (net.Name === networkName) {
          try { await docker.getNetwork(net.Id).remove(); } catch { /* already gone */ }
        }
      }
    } catch { /* ignore */ }

    const network = await docker.createNetwork({
      Name: networkName,
      Driver: 'bridge',
      Options: {
        'com.docker.network.bridge.enable_icc': 'true',
        'com.docker.network.bridge.enable_ip_masquerade': 'true',
      },
      IPAM: { Driver: 'default', Config: [] },
    });

    await network.connect({ Container: node.containerId });

    // Docker reports the MAC address it assigned to the new veth peer inside
    // the container. Use it to rename that specific interface to eth_wan.
    const netInfo = await network.inspect();
    const mac = netInfo.Containers?.[node.containerId]?.MacAddress ?? '';

    const container = docker.getContainer(node.containerId);
    const exec = await container.exec({
      Cmd: ['sh', '-c', `
        mac="${mac}"
        ifaceName="${wanIfaceName}"
        i=0
        while [ $i -lt 20 ]; do
          for f in /sys/class/net/eth*; do
            [ -e "$f" ] || continue
            cur=$(cat "$f/address" 2>/dev/null)
            name=$(basename "$f")
            if [ "$cur" = "$mac" ]; then
              ip link set "$name" down
              ip link set "$name" name "${wanIfaceName}"
              ip link set "${wanIfaceName}" up
              exit 0
            fi
          done
          i=$((i+1))
          sleep 0.1
        done
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
      for (const net of existing) {
        if (net.Name === networkName) {
          try { await docker.getNetwork(net.Id).remove(); } catch { /* already removed */ }
        }
      }
    } catch { /* ignore */ }
  },

  async deleteLink(name: string): Promise<void> {
    const link = links.get(name);
    if (!link?.dockerNetworkId) throw new Error(`Link "${name}" non trovato`);

    const network = docker.getNetwork(link.dockerNetworkId);
    await network.remove();
    links.delete(name);
    persist();
  },
};