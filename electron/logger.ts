import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

let _logPath: string | null = null;

function logPath(): string {
  if (!_logPath) {
    const dir = app.getPath('logs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    _logPath = path.join(dir, `netlab-${new Date().toISOString().slice(0, 10)}.log`);
  }
  return _logPath;
}

function fmt(level: string, args: unknown[]): string {
  const parts = args.map(a =>
    a instanceof Error ? (a.stack ?? a.message)
    : typeof a === 'object' ? JSON.stringify(a)
    : String(a)
  );
  return `[${new Date().toISOString()}] [${level}] ${parts.join(' ')}`;
}

function write(level: string, consoleFn: (...a: unknown[]) => void, args: unknown[]): void {
  if (app.isPackaged) {
    try { fs.appendFileSync(logPath(), fmt(level, args) + '\n'); } catch { /* ignore */ }
  } else {
    consoleFn(fmt(level, args));
  }
}

export const logger = {
  info:  (...args: unknown[]) => write('INFO',  console.log,   args),
  warn:  (...args: unknown[]) => write('WARN',  console.warn,  args),
  error: (...args: unknown[]) => write('ERROR', console.error, args),
};
