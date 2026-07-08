export type NodeStatus = 'created' | 'running' | 'stopped' | 'error';

export interface NetworkInterface {
  name: string;
  linkName: string;
}

export interface Mount {
  hostPath: string;
  containerPath: string;
}

export interface LabNode {
  id: string;
  name: string;
  image: string;
  status: NodeStatus;
  interfaces: NetworkInterface[];
  containerId?: string;
  cpuLimit?: number;  // cores (e.g. 0.5, 1.0, 2.0)
  memoryMb?: number;  // RAM in MB (e.g. 256, 512, 1024)
  mounts?: Mount[];
  internetFacing?: boolean;
  wanIfaceName?: string;
  isSwitch?: boolean;
}
