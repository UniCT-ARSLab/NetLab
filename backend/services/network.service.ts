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

    const link: LabLink = { name, dockerNetworkId: network.id, connectedNodes: [] };
    links.set(name, link);
    persist();
    return link;
  },

  // renaming of interfaces based on mac identification
  async attachInterface(nodeId: string, ifaceName: string, linkName: string): Promise<void> {
    const node = NodeService.get(nodeId);
    if (!node || !node.containerId) throw new Error(`Nodo ${nodeId} non avviato`);

    const link = links.get(linkName);
    if (!link?.dockerNetworkId) throw new Error(`Link "${linkName}" non trovato`);

    const network = docker.getNetwork(link.dockerNetworkId);

    let netInfo = await network.inspect();
    const alreadyConnected = !!(netInfo.Containers?.[node.containerId]);

    if (!alreadyConnected) {
      const othersConnected = Object.keys(netInfo.Containers ?? {}).length;
      if (othersConnected >= 2) {
        throw new Error(`Link "${linkName}" is already at capacity (max 2 nodes)`);
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
    if (!node?.containerId) throw new Error(`Nodo ${nodeId} non ha un container`);

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
    const mac = containerInfo.NetworkSettings?.Networks?.[networkName]?.MacAddress ?? '';

    const exec = await container.exec({
      Cmd: ['sh', '-c', `
        mac="${mac}"
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
      for (const net of existing) {
        if (net.Name === networkName) {
          try { await docker.getNetwork(net.Id).remove(); } catch { /* already removed */ }
        }
      }
    } catch { /* ignore */ }
  },

  async deleteLink(name: string): Promise<void> {
    const link = links.get(name);
    if (!link) throw new Error(`Link "${name}" non trovato`);

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