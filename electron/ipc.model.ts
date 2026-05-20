// Canali IPC condivisi tra main process e renderer Angular
export const IPC_CHANNELS = {
  // Nodi
  NODE_CREATE:  'node:create',
  NODE_UPDATE:  'node:update',
  NODE_START:   'node:start',
  NODE_STOP:    'node:stop',
  NODE_DELETE:  'node:delete',
  NODE_LIST:    'node:list',

  // Link / reti
  LINK_CREATE:  'link:create',
  LINK_DELETE:  'link:delete',
  LINK_LIST:    'link:list',

  // Finestra
  WIN_MINIMIZE: 'win:minimize',
  WIN_MAXIMIZE: 'win:maximize',
  WIN_CLOSE:    'win:close',

  // Terminale
  TERMINAL_OPEN:        'terminal:open',
  TERMINAL_OPEN_WINDOW: 'terminal:open-window',
  TERMINAL_INPUT:       'terminal:input',
  TERMINAL_OUTPUT:      'terminal:output',
  TERMINAL_RESIZE:      'terminal:resize',
  TERMINAL_CLOSE:       'terminal:close',
} as const;

export type IpcChannel = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS];
