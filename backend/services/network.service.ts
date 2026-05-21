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

    // Import orphaned Docker networks
    for (const net of netlabNets) {
      const linkName = net.Name!.slice('netlab_'.length);
      if (!links.has(linkName)) {
        links.set(linkName, { name: linkName, dockerNetworkId: net.Id, connectedNodes: [] });
        changed = true;
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
        .filter(n => n.status === 'running' && n.interfaces.some(i => i.linkName === link.name))
        .map(n => n.id),
    }));
  },

  async createLink(name: string): Promise<LabLink> {
    if (links.has(name)) throw new Error(`Link "${name}" già esistente`);

    const network = await docker.createNetwork({
      Name: `netlab_${name}`,
      Driver: 'bridge',
      // traffic on the same bridge must pass through iptables on Linux 
      // we cannot use Internal=true adds stricter rules that
      // can silently drop packets with non-Docker-assigned source IPs.
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

  // Attaches a running container's interface to a Docker network and renames it.
  // it is ok to call even if the container is already connected

  async attachInterface(nodeId: string, ifaceName: string, linkName: string): Promise<void> {
    const node = NodeService.get(nodeId);
    if (!node || !node.containerId) throw new Error(`Nodo ${nodeId} non avviato`);

    const link = links.get(linkName);
    if (!link?.dockerNetworkId) throw new Error(`Link "${linkName}" non trovato`);

    const network = docker.getNetwork(link.dockerNetworkId);

    //check if already connected
    const netInfo = await network.inspect();
    const alreadyConnected = !!(netInfo.Containers?.[node.containerId]);

    if (!alreadyConnected) {
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

  async deleteLink(name: string): Promise<void> {
    const link = links.get(name);
    if (!link?.dockerNetworkId) throw new Error(`Link "${name}" non trovato`);

    const network = docker.getNetwork(link.dockerNetworkId);
    await network.remove();
    links.delete(name);
    persist();
  },
};