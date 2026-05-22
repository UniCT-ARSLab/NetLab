import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../models/ipc.model';
import { NodeService } from './node.service';

interface Session {
  pty: pty.IPty;
  win: BrowserWindow;
}

const sessions = new Map<string, Session>();

function send(session: Session, channel: string, payload: unknown): void {
  if (!session.win.isDestroyed()) {
    session.win.webContents.send(channel, payload);
  }
}

export const TerminalService = {

  open(nodeId: string, win: BrowserWindow, cols = 80, rows = 24): string {
    const node = NodeService.get(nodeId);
    if (!node || !node.containerId) throw new Error(`Nodo ${nodeId} non avviato`);

    const terminalId = `term_${nodeId}`;

    TerminalService.close(terminalId);

    const env: Record<string, string | undefined> = { ...process.env, TERM: 'xterm-256color' };

    // Use bash if available, fall back to sh (e.g. alpine only has sh)
    const shellCmd = `command -v bash > /dev/null 2>&1 && exec bash || exec sh`;
    let term: pty.IPty;
    if (process.platform === 'darwin') {
      term = pty.spawn(
        '/bin/bash',
        ['-l', '-c', `exec docker exec -it ${node.containerId} sh -c '${shellCmd}'`],
        { name: 'xterm-256color', cols, rows, env },
      );
    } else {
      term = pty.spawn('docker', ['exec', '-it', node.containerId, 'sh', '-c', shellCmd], {
        name: 'xterm-256color', cols, rows, env,
      });
    }

    const session: Session = { pty: term, win };

    term.onData((data: string) => {
      send(session, IPC_CHANNELS.TERMINAL_OUTPUT, { terminalId, data });
    });

    term.onExit(() => {
      sessions.delete(terminalId);
      send(session, IPC_CHANNELS.TERMINAL_CLOSE, { terminalId });
    });

    sessions.set(terminalId, session);
    return terminalId;
  },

  write(terminalId: string, data: string): void {
    const s = sessions.get(terminalId);
    if (!s) return;
    try { s.pty.write(data); } catch { /* PTY already dead */ }
  },

  resize(terminalId: string, cols: number, rows: number): void {
    const s = sessions.get(terminalId);
    if (!s) return;
    try { s.pty.resize(cols, rows); } catch { /* PTY already dead */ }
  },

  notifyStopping(terminalId: string): void {
    const s = sessions.get(terminalId);
    if (!s) return;
    send(s, IPC_CHANNELS.TERMINAL_STOPPING, { terminalId });
  },

  close(terminalId: string): void {
    const s = sessions.get(terminalId);
    if (!s) return;
    try { s.pty.kill(); } catch { /* already dead */ }
    sessions.delete(terminalId);
  },
};
