import { LabNode } from '../../../backend/models/node.model';
import { LabLink } from '../../../backend/models/link.model';
import { CreateNodeParams } from '../../../backend/models/ipc.model';

declare global {
  interface Window {
    electronAPI: {
      // Platform
      platform: string;
      minimizeWindow:   () => Promise<void>;
      maximizeWindow:   () => Promise<void>;
      unmaximizeWindow: () => Promise<void>;
      closeWindow:      () => Promise<void>;
      reloadWindow:     () => Promise<void>;
      onWindowMaximizeChange: (cb: (maximized: boolean) => void) => void;

      // Docker
      checkDocker: () => Promise<boolean>;
      onDockerUnavailable: (cb: () => void) => void;
      onDataReady: (cb: () => void) => void;

      // Nodi
      listNodes: () => Promise<LabNode[]>;
      createNode: (params: CreateNodeParams) => Promise<LabNode>;
      updateNode: (id: string, params: CreateNodeParams) => Promise<LabNode>;
      startNode: (id: string) => Promise<LabNode>;
      stopNode: (id: string) => Promise<LabNode>;
      deleteNode: (id: string) => Promise<void>;
      getNetworkInfo: (id: string) => Promise<{ addr: { name: string; state: string; ips: string }[]; routes: { dest: string; via: string; dev: string }[] }>;

      // Link
      listLinks: () => Promise<LabLink[]>;
      createLink: (name: string, type?: 'cable' | 'switch') => Promise<LabLink>;
      deleteLink: (name: string) => Promise<void>;

      // Terminale - terminale nativo del sistema operativo
      openTerminalNative: (nodeId: string) => Promise<void>;

      // Dialog
      openFolderDialog: () => Promise<string | null>;
    };
  }
}
