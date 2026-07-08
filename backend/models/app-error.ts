export const ERROR_CODES = {
  NODE_NOT_FOUND: 'NODE_NOT_FOUND',
  NODE_NAME_DUPLICATE: 'NODE_NAME_DUPLICATE',
  NODE_NOT_STARTED: 'NODE_NOT_STARTED',
  NODE_NOT_RUNNING: 'NODE_NOT_RUNNING',
  NODE_HAS_NO_CONTAINER: 'NODE_HAS_NO_CONTAINER',
  CONTAINER_NOT_RUNNING: 'CONTAINER_NOT_RUNNING',
  LINK_NOT_FOUND: 'LINK_NOT_FOUND',
  LINK_ALREADY_EXISTS: 'LINK_ALREADY_EXISTS',
  LINK_AT_CAPACITY: 'LINK_AT_CAPACITY',
  LINK_IN_USE: 'LINK_IN_USE',
  NO_TERMINAL_FOUND: 'NO_TERMINAL_FOUND',
  DOCKER_NOT_RUNNING: 'DOCKER_NOT_RUNNING',
  CONTAINER_NAME_CONFLICT: 'CONTAINER_NAME_CONFLICT',
  CONTAINER_NAME_CONFLICT_GENERIC: 'CONTAINER_NAME_CONFLICT_GENERIC',
  IMAGE_NOT_FOUND: 'IMAGE_NOT_FOUND',
  IMAGE_ACCESS_DENIED: 'IMAGE_ACCESS_DENIED',
  NETWORK_NOT_FOUND: 'NETWORK_NOT_FOUND',
  CONTAINER_NOT_FOUND: 'CONTAINER_NOT_FOUND',
  PORT_IN_USE: 'PORT_IN_USE',
  INTERFACE_ATTACH_FAILED: 'INTERFACE_ATTACH_FAILED',
  WAN_BRIDGE_FAILED: 'WAN_BRIDGE_FAILED',
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

// Encoded as JSON in .message because Electron's ipcRenderer.invoke error
// marshaling only reliably preserves the message string across the
// renderer boundary — custom properties on the Error don't survive the
// trip. The frontend parses it back into { code, params } and looks up the
// translation, so backend code never needs to know the UI language.
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly params: Record<string, string>;

  constructor(code: ErrorCode, params: Record<string, string> = {}) {
    super(JSON.stringify({ code, params }));
    this.code = code;
    this.params = params;
  }
}

export function reasonFor(e: unknown): string {
  if (e instanceof AppError) return e.code;
  return e instanceof Error ? e.message : String(e);
}
