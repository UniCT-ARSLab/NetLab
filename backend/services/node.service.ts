import { v4 as uuidv4 } from 'uuid';
import { docker } from './docker.client';
import { DbService } from './db.service';
import { logger } from '../../electron/logger';
import { LabNode, NodeStatus } from '../models/node.model';
import { CreateNodeParams } from '../models/ipc.model';

const LABEL_MANAGED  = 'netlab.managed';
const LABEL_NODE_ID  = 'netlab.node-id';
const LABEL_NODE_NAME = 'netlab.node-name';

let nodes = new Map<string, LabNode>();

function persist(): void {
  DbService.persistNodes(Array.from(nodes.values()));
}

async function ensureImagePresent(image: string): Promise<void> {
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
    const node: LabNode = {
      id: uuidv4(),
      name: params.name,
      image: params.image,
      status: 'created',
      interfaces: (params.interfaces ?? []).map(i => ({ name: i.name, linkName: i.linkName ?? '' })),
      cpuLimit: params.cpuLimit,
      memoryMb: params.memoryMb,
      mounts: params.mounts ?? [],
    };
    nodes.set(node.id, node);
    persist();
    return node;
  },

  update(id: string, params: CreateNodeParams): LabNode {
    const node = nodes.get(id);
    if (!node) throw new Error(`Nodo ${id} non trovato`);

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
    nodes.set(id, node);
    persist();
    return node;
  },

  async start(id: string): Promise<{ node: LabNode; isNewContainer: boolean }> {
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
          return { node, isNewContainer: false };
        }
        await existing.start();
        node.status = 'running';
        persist();
        return { node, isNewContainer: false };
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

    // Remove from the default bridge so the container starts with only lo
    // attachInterface then connects each user-defined interface to its netlab network
    try {
      await docker.getNetwork('bridge').disconnect({ Container: container.id });
    } catch { /* already disconnected or bridge absent */ }

    await container.start();
    node.containerId = container.id;
    node.status = 'running';
    persist();
    return { node, isNewContainer: true };
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
      try { await container.stop(); } catch { /* already stopped */ }
      await container.remove();
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
