import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Dockerode from 'dockerode';

function resolveSocketPath(): string {
  if (process.platform === 'win32') return '//./pipe/docker_engine';
  const defaultSocket = '/var/run/docker.sock';
  if (fs.existsSync(defaultSocket)) return defaultSocket;
  // Docker Desktop's "desktop-linux" context uses a per-user socket when
  // the classic /var/run/docker.sock symlink isn't created.
  const userSocket = path.join(os.homedir(), '.docker/run/docker.sock');
  if (fs.existsSync(userSocket)) return userSocket;
  return defaultSocket;
}

export const docker = new Dockerode({ socketPath: resolveSocketPath() });

export async function isDockerAvailable(): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}
