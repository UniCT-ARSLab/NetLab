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
  checkDocker: () => ipcRenderer.invoke(CH.DOCKER_CHECK),
  onDockerUnavailable: (cb: () => void) => {
    ipcRenderer.on(CH.DOCKER_UNAVAILABLE, () => cb());
  },
  onDataReady: (cb: () => void) => {
    ipcRenderer.on(CH.DATA_READY, () => cb());
  },

  //NODI 
  listNodes: () => ipcRenderer.invoke(CH.NODE_LIST),
  createNode: (params: CreateNodeParams) => ipcRenderer.invoke(CH.NODE_CREATE, params),
  startNode: (id: string) => ipcRenderer.invoke(CH.NODE_START, id),
  stopNode: (id: string) => ipcRenderer.invoke(CH.NODE_STOP, id),
  updateNode: (id: string, params: CreateNodeParams) => ipcRenderer.invoke(CH.NODE_UPDATE, id, params),
  deleteNode: (id: string) => ipcRenderer.invoke(CH.NODE_DELETE, id),
  getNetworkInfo: (id: string) => ipcRenderer.invoke(CH.NODE_NETWORK_INFO, id),

  // LINK 
  listLinks: ()  => ipcRenderer.invoke(CH.LINK_LIST),
  createLink: (name: string, type?: 'cable' | 'switch') => ipcRenderer.invoke(CH.LINK_CREATE, name, type),
  deleteLink: (name: string) => ipcRenderer.invoke(CH.LINK_DELETE, name),

  // TERMINALE
  openTerminalNative: (nodeId: string) =>
    ipcRenderer.invoke(CH.TERMINAL_OPEN_NATIVE, nodeId),

  openFolderDialog: (): Promise<string | null> =>
    ipcRenderer.invoke(CH.DIALOG_OPEN_FOLDER),
});