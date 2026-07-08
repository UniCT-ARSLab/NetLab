import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { docker } from './docker.client';
import { DbService } from './db.service';
import { logger } from '../../electron/logger';
import { LabNode, NodeStatus } from '../models/node.model';
import { CreateNodeParams } from '../models/ipc.model';
import { AppError } from '../models/app-error';

const LABEL_MANAGED  = 'netlab.managed';
const LABEL_NODE_ID  = 'netlab.node-id';
const LABEL_NODE_NAME = 'netlab.node-name';

// Same network toolset across all three distros, so behavior doesn't change
// depending on which image the student picks.
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

// An orphaned NetLab container (managed by us, but whose id is no longer
// tracked by any node — e.g. a wiped/corrupted DB, or removed by hand while
// keeping the name) can block creating a new container with the same name.
// If it's really ours and doesn't belong to another active node, remove it
// and retry instead of staying stuck forever.
async function removeOrphanedContainerByName(name: string): Promise<boolean> {
  const all = await docker.listContainers({ all: true });
  const match = all.find(c => c.Names.some(n => n === `/${name}`));
  if (!match || !match.Labels?.[LABEL_MANAGED]) return false;
  if (Array.from(nodes.values()).some(n => n.containerId === match.Id)) return false;
  try {
    await docker.getContainer(match.Id).remove({ force: true });
    return true;
  } catch {
    return false;
  }
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

// Custom images are built locally, not pullable from a registry: if one is
// missing when a node starts (the user could have deleted it after the app
// launched, e.g. "docker image prune"), it needs to be rebuilt, not pulled —
// otherwise dockerode would fail looking for a repository that doesn't exist.
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

  // Built at app startup (not lazily on first node creation), so the
  // student never waits in the middle of an in-progress exercise.
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

    // import containers that carry the netlab label but are not in the DB
    // happens when the user data directory is wiped while Docker containers remain
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
      throw new AppError('NODE_NAME_DUPLICATE', { name: params.name });
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
    if (!node) throw new AppError('NODE_NOT_FOUND', { id });
    if (Array.from(nodes.values()).some(n => n.id !== id && n.name === params.name)) {
      throw new AppError('NODE_NAME_DUPLICATE', { name: params.name });
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
    if (!node) throw new AppError('NODE_NOT_FOUND', { id });

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

    const containerOptions = {
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
    };

    let container;
    try {
      container = await docker.createContainer(containerOptions);
    } catch (e: any) {
      // An orphaned NetLab container with the same name (DB out of sync
      // because of manipulation outside Docker) blocks creation with the
      // classic 409 "name already in use" — if it's really ours and not
      // another active node's, clean it up and retry once.
      if (e?.statusCode !== 409 || !(await removeOrphanedContainerByName(node.name))) throw e;
      container = await docker.createContainer(containerOptions);
    }

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
    if (!node || !node.containerId) throw new AppError('NODE_NOT_STARTED', { id });

    const container = docker.getContainer(node.containerId);
    await container.stop();

    node.status = 'stopped';
    nodes.set(id, node);
    persist();
    return node;
  },

  async delete(id: string): Promise<void> {
    const node = nodes.get(id);
    if (!node) throw new AppError('NODE_NOT_FOUND', { id });

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
