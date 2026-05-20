import { ipcMain, BrowserWindow, app, dialog, screen } from 'electron';
import * as path from 'path';
import { IPC_CHANNELS, CreateNodeParams } from '../backend/models/ipc.model';
import { NodeService } from '../backend/services/node.service';
import { NetworkService } from '../backend/services/network.service';
import { TerminalService } from '../backend/services/terminal.service';
import { isDockerAvailable } from '../backend/services/docker.client';
import { logger } from './logger';

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
      const { node, isNewContainer } = await NodeService.start(id);

      if (isNewContainer) {
        for (const iface of node.interfaces) {
          if (iface.linkName) {
            try {
              await NetworkService.attachInterface(node.id, iface.name, iface.linkName);
            } catch (e) {
              logger.error(`attachInterface failed for ${iface.name}→${iface.linkName}:`, e);
              throw new Error(
                `Impossibile collegare l'interfaccia "${iface.name}" al link "${iface.linkName}": ${e instanceof Error ? e.message : String(e)}`
              );
            }
          }
        }
      } else {
        for (const iface of node.interfaces) {
          if (iface.linkName) {
            try { await NetworkService.flushInterface(node.id, iface.name); } catch { /* ignore */ }
          }
        }
        for (const [ifaceName, addresses] of Object.entries(node.savedIPs ?? {})) {
          for (const address of addresses) {
            try { await NetworkService.addAddress(node.id, ifaceName, address); } catch { /* ignore */ }
          }
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
      const node = NodeService.get(id);
      if (node?.status === 'running') {
        const linked = node.interfaces.filter(i => i.linkName).map(i => i.name);
        if (linked.length > 0) {
          const savedIPs = await NetworkService.captureIPs(id, linked);
          NodeService.saveIPs(id, savedIPs);
        }
      }
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
      return await NodeService.delete(id);
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