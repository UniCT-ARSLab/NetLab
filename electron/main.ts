import { app, BrowserWindow, Menu } from 'electron';
import * as path from 'path';

// Prevent GTK from using the native portal file chooser, which causes a
// GtkFileChooserNative → GtkWidget cast error on WSLg / certain GTK versions.
if (process.platform === 'linux') {
  process.env['GTK_USE_PORTAL'] = '0';
}
import { registerIpcHandlers } from './ipc-handlers';
import { logger } from './logger';
import { DbService } from '../backend/services/db.service';
import { NodeService } from '../backend/services/node.service';
import { NetworkService } from '../backend/services/network.service';
import { isDockerAvailable } from '../backend/services/docker.client';

let win: BrowserWindow | null = null;

async function createWindow(): Promise<void> {
  Menu.setApplicationMenu(null);

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'NetLab',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 16, y: 14 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  registerIpcHandlers(win);

  const isDev = !app.isPackaged;
  if (isDev) {
    await win.loadURL('http://localhost:4200');
    win.webContents.openDevTools();
  } else {
    await win.loadFile(path.join(__dirname, '../frontend/browser/index.html'));
    win.webContents.on('devtools-opened', () => win?.webContents.closeDevTools());
  }

  const dockerOk = await isDockerAvailable();
  if (!dockerOk) {
    logger.warn('Docker non raggiungibile.');
    win.webContents.send('docker:unavailable');
    return;
  }

  // Fire-and-forget: runs in the background, the callers that actually need
  // it (container creation) await the same cached promise.
  NetworkService.ensureFallbackTunnelsDisabled();

  // DB/Docker reconciliation + building the custom images (alpine/debian/
  // ubuntu with the network tools). Images are built here, not on first
  // node creation, so the student never waits mid-exercise — only the
  // app's first launch will be slower.
  Promise.all([
    NetworkService.reconcile(),
    NodeService.reconcileContainers(),
    NodeService.ensureCustomImagesBuilt(),
  ])
    .then(() => win?.webContents.send('data:ready'))
    .catch(e => logger.warn('Reconciliation parziale:', e));
}

app.whenReady().then(() => {
  DbService.init(app.getPath('userData'));
  NodeService.init();
  NetworkService.init();
  createWindow();
});

let isQuitting = false;
app.on('before-quit', (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;

  NodeService.stopAllRunning()
    .catch(e => logger.warn('Cleanup alla chiusura:', e))
    .finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});