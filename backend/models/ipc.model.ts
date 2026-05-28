export interface CreateNodeParams {
  name: string;
  image: string;
  cpuLimit?: number;
  memoryMb?: number;
  interfaces?: Array<{ name: string; linkName: string }>;
  mounts?: Array<{ hostPath: string; containerPath: string }>;
  internetFacing?: boolean;
}

export const IPC_CHANNELS = {
  // Nodi
  NODE_CREATE:  'node:create',
  NODE_UPDATE:  'node:update',
  NODE_START:   'node:start',
  NODE_STOP:    'node:stop',
  NODE_DELETE:  'node:delete',
  NODE_LIST:    'node:list',

  // Links
  LINK_CREATE:  'link:create',
  LINK_DELETE:  'link:delete',
  LINK_LIST:    'link:list',

  // Terminale
  TERMINAL_OPEN:        'terminal:open',
  TERMINAL_OPEN_WINDOW: 'terminal:open-window',
  TERMINAL_INPUT:       'terminal:input',
  TERMINAL_OUTPUT:      'terminal:output',
  TERMINAL_RESIZE:      'terminal:resize',
  TERMINAL_CLOSE:       'terminal:close',
  TERMINAL_STOPPING:    'terminal:stopping',

  // Dialog
  DIALOG_OPEN_FOLDER: 'dialog:open-folder',

  // Node info
  NODE_NETWORK_INFO:  'node:network-info',

  // Docker
  DOCKER_CHECK:       'docker:check',
  DOCKER_UNAVAILABLE: 'docker:unavailable',
  DATA_READY:         'data:ready',
} as const;

export type IpcChannel = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS];
