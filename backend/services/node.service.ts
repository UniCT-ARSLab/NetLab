import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { docker } from './docker.client';
import { DbService } from './db.service';
import { logger } from '../../electron/logger';
import { LabNode, NodeStatus } from '../models/node.model';
import { CreateNodeParams } from '../models/ipc.model';

const LABEL_MANAGED  = 'netlab.managed';
const LABEL_NODE_ID  = 'netlab.node-id';
const LABEL_NODE_NAME = 'netlab.node-name';

// Stesso set di strumenti di rete su tutte e tre le distro, così il
// comportamento non cambia in base all'immagine scelta dallo studente.
const CUSTOM_IMAGE_PACKAGES_APT = 'iproute2 iptables bridge-utils tcpdump ethtool iputils-ping dnsutils curl wget vim nano traceroute';
const CUSTOM_IMAGE_PACKAGES_APK = 'iproute2 iptables bridge-utils tcpdump ethtool iputils bind-tools curl wget vim nano traceroute';

const CUSTOM_IMAGES: Record<string, string> = {
  'netlab-alpine:v1': `FROM alpine:3.20\nRUN apk add --no-cache ${CUSTOM_IMAGE_PACKAGES_APK}\n`,
  'netlab-debian:v1': `FROM debian:bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends ${CUSTOM_IMAGE_PACKAGES_APT} && rm -rf /var/lib/apt/lists/*\n`,
  'netlab-ubuntu:v1': `FROM ubuntu:24.04\nRUN apt-get update && apt-get install -y --no-install-recommends ${CUSTOM_IMAGE_PACKAGES_APT} && rm -rf /var/lib/apt/lists/*\n`,
};

let nodes = new Map<string, LabNode>();

function persist(): void {
  DbService.persistNodes(Array.from(nodes.values()));
}

async function ensureCustomImageBuilt(tag: string, dockerfile: string): Promise<void> {
  try {
    await docker.getImage(tag).inspect();
  } catch {
    const contextPath = fs.mkdtempSync(path.join(os.tmpdir(), 'netlab-image-'));
    fs.writeFileSync(path.join(contextPath, 'Dockerfile'), dockerfile);
    const stream = await docker.buildImage({ context: contextPath, src: ['Dockerfile'] }, { t: tag });
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err: Error | null) => err ? reject(err) : resolve());
    });
    fs.rmSync(contextPath, { recursive: true, force: true });
  }
}

// Le immagini custom sono buildate localmente, non pullabili da un registry:
// se un'immagine risulta mancante allo start di un nodo (l'utente potrebbe
// averla cancellata dopo l'avvio dell'app, es. "docker image prune"), va
// ricostruita, non "pullata" — altrimenti dockerode fallirebbe cercando un
// repository che non esiste.
async function ensureImagePresent(image: string): Promise<void> {
  const customDockerfile = CUSTOM_IMAGES[image];
  if (customDockerfile) {
    await ensureCustomImageBuilt(image, customDockerfile);
    return;
  }
  try {
    await docker.getImage(image).inspect();
  } catch {
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err2: Error | null) => err2 ? reject(err2) : resolve());
      });
    });
  }
}

export const NodeService = {

  init(): void {
    nodes = new Map(DbService.getNodes().map(n => [n.id, n]));
  },

  // Buildate all'avvio dell'app (non pigramente alla prima creazione nodo),
  // così lo studente non aspetta mai durante un esercizio in corso.
  async ensureCustomImagesBuilt(): Promise<void> {
    for (const [tag, dockerfile] of Object.entries(CUSTOM_IMAGES)) {
      try {
        await ensureCustomImageBuilt(tag, dockerfile);
      } catch (e) {
        logger.warn(`Build immagine "${tag}" fallita:`, e);
      }
    }
  },

  // after db init syncronize container states with docker
  async reconcileContainers(): Promise<void> {
    let changed = false;
    const dockerContainers = await docker.listContainers({ all: true });

    // Step 1: sync nodes that are already in the DB
    for (const [id, node] of nodes) {
      let dc = node.containerId
        ? dockerContainers.find(c => c.Id === node.containerId)
        : undefined;

      // fall back to name lookup (handles crashes where containerId was not saved)
      if (!dc) {
        dc = dockerContainers.find(c =>
          c.Names.some(n => n === `/${node.name}`)
        );
        if (dc) node.containerId = dc.Id;
      }

      if (dc) {
        const newStatus: NodeStatus = dc.State === 'running' ? 'running' : 'stopped';
        if (node.status !== newStatus) { node.status = newStatus; changed = true; }
      } else if (node.containerId) {
        node.containerId = undefined;
        node.status = 'created';
        changed = true;
      }

      nodes.set(id, node);
    }

    //import containers that carry the netlab label but are not in the DB
    //happens when the user data directory is wiped while Docker containers remain
    const knownIds  = new Set(Array.from(nodes.values()).map(n => n.containerId).filter(Boolean));
    const knownNames = new Set(Array.from(nodes.values()).map(n => n.name));

    for (const dc of dockerContainers) {
      if (!dc.Labels?.[LABEL_MANAGED]) continue;
      if (knownIds.has(dc.Id)) continue;

      const nodeId   = dc.Labels[LABEL_NODE_ID];
      const nodeName = dc.Labels[LABEL_NODE_NAME];
      if (!nodeId || !nodeName) continue;
      if (nodes.has(nodeId) || knownNames.has(nodeName)) continue;

      const status: NodeStatus = dc.State === 'running' ? 'running' : 'stopped';
      nodes.set(nodeId, {
        id: nodeId,
        name: nodeName,
        image: dc.Image,
        status,
        containerId: dc.Id,
        interfaces: [],
        mounts: [],
      });
      logger.info(`Reconcile: imported orphaned container "${nodeName}" (${dc.Id.slice(0, 12)})`);
      changed = true;
    }

    if (changed) persist();
  },

  list(): LabNode[] {
    return Array.from(nodes.values());
  },

  get(id: string): LabNode | undefined {
    return nodes.get(id);
  },

  async create(params: CreateNodeParams): Promise<LabNode> {
    if (Array.from(nodes.values()).some(n => n.name === params.name)) {
      throw new Error(`Esiste già un nodo con il nome "${params.name}"`);
    }
    const node: LabNode = {
      id: uuidv4(),
      name: params.name,
      image: params.image,
      status: 'created',
      interfaces: (params.interfaces ?? []).map(i => ({ name: i.name, linkName: i.linkName ?? '' })),
      cpuLimit: params.cpuLimit,
      memoryMb: params.memoryMb,
      mounts: params.mounts ?? [],
      internetFacing: params.internetFacing ?? false,
      wanIfaceName: params.wanIfaceName ?? 'eth_wan',
      isSwitch: params.isSwitch ?? false,
    };
    nodes.set(node.id, node);
    persist();
    return node;
  },

  update(id: string, params: CreateNodeParams): LabNode {
    const node = nodes.get(id);
    if (!node) throw new Error(`Nodo ${id} non trovato`);
    if (Array.from(nodes.values()).some(n => n.id !== id && n.name === params.name)) {
      throw new Error(`Esiste già un nodo con il nome "${params.name}"`);
    }

    node.name = params.name;
    node.image = params.image;
    node.cpuLimit = params.cpuLimit;
    node.memoryMb = params.memoryMb;
    if (params.interfaces !== undefined) {
      node.interfaces = params.interfaces.map(i => ({ name: i.name, linkName: i.linkName ?? '' }));
    }
    if (params.mounts !== undefined) {
      node.mounts = params.mounts;
    }
    if (params.internetFacing !== undefined) {
      node.internetFacing = params.internetFacing;
    }
    if (params.wanIfaceName !== undefined) {
      node.wanIfaceName = params.wanIfaceName;
    }
    if (params.isSwitch !== undefined) {
      node.isSwitch = params.isSwitch;
    }
    nodes.set(id, node);
    persist();
    return node;
  },

  async start(id: string): Promise<LabNode> {
    const node = nodes.get(id);
    if (!node) throw new Error(`Nodo ${id} non trovato`);

    // reuse container previously created if still present
    if (node.containerId) {
      const existing = docker.getContainer(node.containerId);
      try {
        const info = await existing.inspect();
        if (info.State.Running) {
          node.status = 'running';
          persist();
          return node;
        }
        await existing.start();
        node.status = 'running';
        persist();
        return node;
      } catch (e: any) {
        if (e?.statusCode !== 404) throw e;
        // deleted container, create a new one 
        node.containerId = undefined;
      }
    }

    await ensureImagePresent(node.image);

    const container = await docker.createContainer({
      name: node.name,
      Image: node.image,
      Tty: true,
      OpenStdin: true,
      Labels: {
        [LABEL_MANAGED]:   'true',
        [LABEL_NODE_ID]:   node.id,
        [LABEL_NODE_NAME]: node.name,
      },
      HostConfig: {
        Privileged: true,
        Binds: (node.mounts ?? []).map(m => `${m.hostPath}:${m.containerPath}`),
        ...(node.cpuLimit ? { NanoCpus: Math.round(node.cpuLimit * 1e9) } : {}),
        ...(node.memoryMb ? { Memory: node.memoryMb * 1024 * 1024 } : {}),
      },
    });

    await container.start();

    // Docker attaches the default bridge network only once the container
    // actually starts, so the disconnect must happen after start, not before
    // (disconnecting before start has nothing to disconnect and is a no-op).
    try { await docker.getNetwork('bridge').disconnect({ Container: container.id }); } catch { /* ignore */ }
    node.containerId = container.id;
    node.status = 'running';
    persist();
    return node;
  },

  async stop(id: string): Promise<LabNode> {
    const node = nodes.get(id);
    if (!node || !node.containerId) throw new Error(`Nodo ${id} non avviato`);

    const container = docker.getContainer(node.containerId);
    await container.stop();

    node.status = 'stopped';
    nodes.set(id, node);
    persist();
    return node;
  },

  async delete(id: string): Promise<void> {
    const node = nodes.get(id);
    if (!node) throw new Error(`Nodo ${id} non trovato`);

    if (node.containerId) {
      const container = docker.getContainer(node.containerId);
      try { await container.stop(); } catch { /* already stopped or gone */ }
      try { await container.remove(); } catch (e: any) { if (e?.statusCode !== 404) throw e; }
    }

    nodes.delete(id);
    persist();
  },

  updateStatus(id: string, status: NodeStatus): void {
    const node = nodes.get(id);
    if (node) {
      node.status = status;
      nodes.set(id, node);
      persist();
    }
  },

  async stopAllRunning(): Promise<void> {
    const running = Array.from(nodes.values()).filter(n => n.status === 'running' && n.containerId);
    await Promise.all(running.map(async (n) => {
      try {
        await docker.getContainer(n.containerId!).stop({ t: 2 });
        n.status = 'stopped';
      } catch (e) {
        logger.warn(`Stop ${n.name}:`, e);
      }
    }));
    persist();
  },
};
