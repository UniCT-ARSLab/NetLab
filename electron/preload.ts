import { contextBridge, ipcRenderer } from 'electron';
import type { CreateNodeParams } from '../backend/models/ipc.model';

const CH = {
  NODE_LIST:            'node:list',
  NODE_NETWORK_INFO:    'node:network-info',
  NODE_CREATE:          'node:create',
  NODE_START:           'node:start',
  NODE_STOP:            'node:stop',
  NODE_UPDATE:          'node:update',
  NODE_DELETE:          'node:delete',
  LINK_LIST:            'link:list',
  LINK_CREATE:          'link:create',
  LINK_DELETE:          'link:delete',
  TERMINAL_OPEN_NATIVE: 'terminal:open-native',
  DOCKER_CHECK:         'docker:check',
  DOCKER_UNAVAILABLE:   'docker:unavailable',
  DATA_READY:           'data:ready',
  DIALOG_OPEN_FOLDER:   'dialog:open-folder',
} as const;

// Electron prefixes every rejected ipcRenderer.invoke() with
// "Error invoking remote method '<channel>': " followed by the original
// error's own "Error: <message>" — this leaks straight into the UI unless
// stripped here, the one place we see the raw rejection before it reaches
// the renderer's application code.
function cleanIpcError(e: unknown): Error {
  const raw = e instanceof Error ? e.message : String(e);
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '');
  return new Error(cleaned || raw);
}

function invoke(channel: string, ...args: unknown[]): Promise<any> {
  return ipcRenderer.invoke(channel, ...args).catch((e: unknown) => { throw cleanIpcError(e); });
}

contextBridge.exposeInMainWorld('electronAPI', {

  platform: process.platform,
  minimizeWindow:   () => ipcRenderer.invoke('win:minimize'),
  maximizeWindow:   () => ipcRenderer.invoke('win:maximize'),
  unmaximizeWindow: () => ipcRenderer.invoke('win:unmaximize'),
  closeWindow:      () => ipcRenderer.invoke('win:close'),
  reloadWindow:     () => ipcRenderer.invoke('win:reload'),
  onWindowMaximizeChange: (cb: (maximized: boolean) => void) => {
    ipcRenderer.on('win:maximize-change', (_e, maximized: boolean) => cb(maximized));
  },


  //  DOCKER
  checkDocker: () => invoke(CH.DOCKER_CHECK),
  onDockerUnavailable: (cb: () => void) => {
    ipcRenderer.on(CH.DOCKER_UNAVAILABLE, () => cb());
  },
  onDataReady: (cb: () => void) => {
    ipcRenderer.on(CH.DATA_READY, () => cb());
  },

  // NODES
  listNodes: () => invoke(CH.NODE_LIST),
  createNode: (params: CreateNodeParams) => invoke(CH.NODE_CREATE, params),
  startNode: (id: string) => invoke(CH.NODE_START, id),
  stopNode: (id: string) => invoke(CH.NODE_STOP, id),
  updateNode: (id: string, params: CreateNodeParams) => invoke(CH.NODE_UPDATE, id, params),
  deleteNode: (id: string) => invoke(CH.NODE_DELETE, id),
  getNetworkInfo: (id: string) => invoke(CH.NODE_NETWORK_INFO, id),

  // LINK
  listLinks: ()  => invoke(CH.LINK_LIST),
  createLink: (name: string) => invoke(CH.LINK_CREATE, name),
  deleteLink: (name: string) => invoke(CH.LINK_DELETE, name),

  // TERMINAL
  openTerminalNative: (nodeId: string) =>
    invoke(CH.TERMINAL_OPEN_NATIVE, nodeId),

  openFolderDialog: (): Promise<string | null> =>
    invoke(CH.DIALOG_OPEN_FOLDER),
});
