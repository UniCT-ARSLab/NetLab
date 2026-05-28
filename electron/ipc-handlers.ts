import { ipcMain, BrowserWindow, app, dialog, screen } from 'electron';
import * as path from 'path';
import { IPC_CHANNELS, CreateNodeParams } from '../backend/models/ipc.model';
import { NodeService } from '../backend/services/node.service';
import { NetworkService } from '../backend/services/network.service';
import { TerminalService } from '../backend/services/terminal.service';
import { docker, isDockerAvailable } from '../backend/services/docker.client';
import { logger } from './logger';

// Docker exec streams are multiplexed: each frame has an 8-byte header
// (1 byte type, 3 bytes padding, 4 bytes payload length) followed by the payload.
function demuxDockerStream(stream: NodeJS.ReadableStream): Promise<string> {
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

// Parse `ip addr` output (works on both full iproute2 and BusyBox).
// Returns one line per non-loopback interface: "eth0      UP     10.0.1.50/24"
function formatAddrSection(raw: string): string {
  const entries: Array<{ name: string; state: string; ips: string[] }> = [];
  let cur: { name: string; state: string; ips: string[] } | null = null;

  for (const line of raw.split('\n')) {
    // Interface header: "2: eth0@if5: <FLAGS> ... state UP ..."
    const ifm = line.match(/^\d+:\s+([^:@\s]+)(?:@\S+)?:\s+<[^>]+>.*\bstate\s+(\S+)/);
    if (ifm) {
      if (cur) entries.push(cur);
      cur = { name: ifm[1], state: ifm[2], ips: [] };
      continue;
    }
    if (!cur) continue;
    const v4 = line.match(/^\s+inet\s+(\S+)/);
    if (v4) { cur.ips.push(v4[1]); continue; }
    const v6 = line.match(/^\s+inet6\s+(\S+)/);
    // skip loopback ::1 and link-local fe80::
    if (v6 && !v6[1].startsWith('fe80') && v6[1] !== '::1/128') cur.ips.push(v6[1]);
  }
  if (cur) entries.push(cur);

  const lines = entries
    .filter(e => e.name !== 'lo')
    .map(e => {
      const state = e.state === 'UP' ? 'UP' : e.state === 'DOWN' ? 'DOWN' : '?';
      const ips   = e.ips.length ? e.ips.join('  ') : 'no address';
      return `${e.name.padEnd(12)}${state.padEnd(8)}${ips}`;
    });
  return lines.length ? lines.join('\n') : '—';
}

// Parse `ip route` output and strip kernel noise, presenting it concisely.
// "10.0.1.0/24 dev eth0 proto kernel scope link src 10.0.1.50"
//   → "10.0.1.0/24         → eth0  (direct)"
// "default via 10.0.1.1 dev eth0" → "default             → 10.0.1.1  (eth0)"
function formatRouteSection(raw: string): string {
  const rows = raw.split('\n').filter(l => l.trim()).map(line => {
    const p      = line.trim().split(/\s+/);
    const dest   = p[0];
    const viaIdx = p.indexOf('via');
    const devIdx = p.indexOf('dev');
    const gw  = viaIdx >= 0 ? p[viaIdx + 1] : undefined;
    const dev = devIdx >= 0 ? p[devIdx + 1] : undefined;
    const d   = dest.padEnd(20);
    if (gw && dev) return `${d}→ ${gw}  (${dev})`;
    if (dev)       return `${d}→ ${dev}  (direct)`;
    return line.trim();
  });
  return rows.length ? rows.join('\n') : '—';
}

function toUserError(e: unknown): Error {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  const code = (e as Record<string, unknown>)?.['statusCode'] as number | undefined;

  if (msg.includes('enoent') || msg.includes('econnrefused') ||
      msg.includes('docker.sock') || msg.includes('pipe/docker_engine')) {
    return new Error('Docker non è in esecuzione. Avvialo e riprova.');
  }
  if (code === 409 || msg.includes('already in use') || msg.includes('conflict')) {
    const name = (e instanceof Error ? e.message : '').match(/name "\/?([^"]+)"/)?.[1];
    return new Error(
      name
        ? `Esiste già un container con il nome "${name}". Elimina il nodo corrispondente o rinominalo prima di avviarlo.`
        : 'Esiste già un container con questo nome. Elimina il nodo o rinominalo prima di avviarlo.'
    );
  }
  if (msg.includes('no such image') || msg.includes('manifest unknown') ||
      msg.includes('manifest for') || (code === 404 && msg.includes('image'))) {
    return new Error("Immagine Docker non trovata. Verifica il nome dell'immagine nella configurazione del nodo.");
  }
  if (msg.includes('pull access denied') || msg.includes('unauthorized') || msg.includes('authentication required')) {
    return new Error("Accesso all'immagine Docker negato. Verifica il nome dell'immagine.");
  }
  if (msg.includes('no such container') || (code === 404 && msg.includes('container'))) {
    return new Error('Container non trovato. Prova a eliminare il nodo e ricrearlo.');
  }
  if (msg.includes('port is already allocated') || msg.includes('address already in use')) {
    return new Error('Una porta richiesta è già in uso da un altro processo.');
  }
  logger.error('Unhandled Docker error:', e);
  return e instanceof Error ? e : new Error(e instanceof Error ? e.message : String(e));
}

export function registerIpcHandlers(_win: BrowserWindow): void {

  // FINESTRA

  // Push maximize state to the renderer so the toolbar icon stays in sync
  const pushMaxState = (w: BrowserWindow, maximized: boolean) =>
    w.webContents.send('win:maximize-change', maximized);
  _win.on('maximize',   () => pushMaxState(_win, true));
  _win.on('unmaximize', () => pushMaxState(_win, false));

  
  const savedBounds = new Map<number, Electron.Rectangle>();

  ipcMain.handle('win:minimize', (_e) => BrowserWindow.fromWebContents(_e.sender)?.minimize());

  ipcMain.handle('win:maximize', (_e) => {
    const w = BrowserWindow.fromWebContents(_e.sender);
    if (!w) return;
    if (process.platform === 'linux') {
      savedBounds.set(w.id, w.getBounds());
      const { x, y, width, height } = screen.getDisplayNearestPoint(w.getBounds()).workArea;
      w.setBounds({ x, y, width, height }, true);
      pushMaxState(w, true);
    } else {
      w.maximize();
    }
  });

  ipcMain.handle('win:unmaximize', (_e) => {
    const w = BrowserWindow.fromWebContents(_e.sender);
    if (!w) return;
    if (process.platform === 'linux') {
      const prev = savedBounds.get(w.id);
      if (prev) {
        w.setBounds(prev, true);
        savedBounds.delete(w.id);
      }
      pushMaxState(w, false);
    } else {
      w.unmaximize();
    }
  });

  ipcMain.handle('win:close', (_e) => BrowserWindow.fromWebContents(_e.sender)?.close());

  ipcMain.handle('win:reload', async (_e) => {
    const w = BrowserWindow.fromWebContents(_e.sender);
    if (!w) return;
    if (app.isPackaged) {
      await w.loadFile(path.join(__dirname, '../frontend/browser/index.html'));
    } else {
      await w.loadURL('http://localhost:4200');
    }
  });

  // DOCKER

  ipcMain.handle('docker:check', async () => isDockerAvailable());

  // NODI 

  ipcMain.handle(IPC_CHANNELS.NODE_LIST, async () => {
    return NodeService.list();
  });

  ipcMain.handle(IPC_CHANNELS.NODE_CREATE, async (_e, params: CreateNodeParams) => {
    return NodeService.create(params);
  });

  ipcMain.handle(IPC_CHANNELS.NODE_UPDATE, async (_e, id: string, params: CreateNodeParams) => {
    return NodeService.update(id, params);
  });

  ipcMain.handle(IPC_CHANNELS.NODE_START, async (_e, id: string) => {
    try {
      const node = await NodeService.start(id);

      // Always attach interfaces — handles both first start and restarts where
      // a link was added/changed since the container was created.
      // attachInterface is idempotent (skips network.connect if already connected)
      // and ends with an ip addr flush, so no separate flushInterface needed.
      for (const iface of node.interfaces) {
        if (!iface.linkName) continue;
        try {
          await NetworkService.attachInterface(node.id, iface.name, iface.linkName);
        } catch (e) {
          logger.error(`attachInterface failed for ${iface.name}→${iface.linkName}:`, e);
          throw new Error(
            `Impossibile collegare l'interfaccia "${iface.name}" al link "${iface.linkName}": ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }

      // Internet-facing nodes get a dedicated WAN bridge with ip_masquerade=true.
      // The student must still configure ip_forward, iptables MASQUERADE rules,
      // and routes manually — Docker only handles the NAT subnet setup.
      if (node.internetFacing) {
        try {
          await NetworkService.createWanBridge(node.id);
        } catch (e) {
          logger.error(`createWanBridge failed for ${node.name}:`, e);
          throw new Error(
            `Impossibile creare l'interfaccia WAN per "${node.name}": ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }

      return node;
    } catch (e) {
      throw toUserError(e);
    }
  });

  ipcMain.handle(IPC_CHANNELS.NODE_STOP, async (_e, id: string) => {
    try {
      TerminalService.notifyStopping(`term_${id}`);
      const result = await NodeService.stop(id);
      TerminalService.close(`term_${id}`);
      return result;
    } catch (e) {
      throw toUserError(e);
    }
  });

  ipcMain.handle(IPC_CHANNELS.NODE_DELETE, async (_e, id: string) => {
    try {
      TerminalService.close(`term_${id}`);
      const node = NodeService.get(id);
      if (node?.internetFacing) {
        await NetworkService.deleteWanBridge(id);
      }
      return await NodeService.delete(id);
    } catch (e) {
      throw toUserError(e);
    }
  });

  ipcMain.handle(IPC_CHANNELS.NODE_NETWORK_INFO, async (_e, id: string) => {
    try {
      const node = NodeService.get(id);
      if (!node?.containerId) throw new Error('Container not running');
      const container = docker.getContainer(node.containerId);
      const exec = await container.exec({
        Cmd: ['sh', '-c', 'ip addr 2>/dev/null; echo "§§§"; ip route 2>/dev/null'],
        AttachStdout: true,
        AttachStderr: false,
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      const output = await demuxDockerStream(stream);
      const [addrRaw = '', routeRaw = ''] = output.split('§§§');
      return { addr: formatAddrSection(addrRaw), routes: formatRouteSection(routeRaw) };
    } catch (e) {
      throw toUserError(e);
    }
  });

  // LINK

  ipcMain.handle(IPC_CHANNELS.LINK_LIST, async () => {
    return NetworkService.list();
  });

  ipcMain.handle(IPC_CHANNELS.LINK_CREATE, async (_e, name: string) => {
    try {
      return await NetworkService.createLink(name);
    } catch (e) {
      throw toUserError(e);
    }
  });

  ipcMain.handle(IPC_CHANNELS.LINK_DELETE, async (_e, name: string) => {
    try {
      return await NetworkService.deleteLink(name);
    } catch (e) {
      throw toUserError(e);
    }
  });

  //TERMINALE 

  ipcMain.handle(IPC_CHANNELS.TERMINAL_OPEN, async (_e, nodeId: string, cols: number, rows: number) => {
    const senderWin = BrowserWindow.fromWebContents(_e.sender);
    if (!senderWin) throw new Error('Finestra sorgente non trovata');
    try {
      return TerminalService.open(nodeId, senderWin, cols, rows);
    } catch (e) {
      throw toUserError(e);
    }
  });

  ipcMain.on(IPC_CHANNELS.TERMINAL_INPUT, (_e, terminalId: string, data: string) => {
    TerminalService.write(terminalId, data);
  });

  ipcMain.on(IPC_CHANNELS.TERMINAL_RESIZE, (_e, terminalId: string, cols: number, rows: number) => {
    TerminalService.resize(terminalId, cols, rows);
  });

  ipcMain.on(IPC_CHANNELS.TERMINAL_CLOSE, (_e, terminalId: string) => {
    TerminalService.close(terminalId);
  });

  // DIALOG

  ipcMain.handle(IPC_CHANNELS.DIALOG_OPEN_FOLDER, async (_e) => {
    const senderWin = BrowserWindow.fromWebContents(_e.sender) ?? undefined;
    const result = await dialog.showOpenDialog(senderWin as BrowserWindow, {
      properties: ['openDirectory'],
      title: 'Seleziona cartella da condividere',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // FINESTRA TERMINALE

  ipcMain.handle(IPC_CHANNELS.TERMINAL_OPEN_WINDOW, async (_e, nodeId: string, _nodeName: string) => {
    const node = NodeService.get(nodeId);
    if (!node) throw new Error(`Nodo ${nodeId} non trovato`);
    if (node.status !== 'running') throw new Error(`Il nodo "${node.name}" non è in esecuzione`);

    const termWin = new BrowserWindow({
      width: 900,
      height: 600,
      title: `Terminal — ${node.name}`,
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 10, y: 11 } }
        : {
            frame: false,
          }),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const query = new URLSearchParams({ nodeId, nodeName: node.name });

    if (!app.isPackaged) {
      await termWin.loadURL(`http://localhost:4200/#/terminal?${query.toString()}`);
    } else {
      await termWin.loadFile(path.join(__dirname, '../frontend/browser/index.html'), {
        hash: `/terminal?${query.toString()}`,
      });
    }
  });
}