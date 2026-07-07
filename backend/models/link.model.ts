export type LabLinkType = 'cable' | 'switch';

export interface LabLink {
  name: string;
  type: LabLinkType;
  dockerNetworkId?: string;
  connectedNodes: string[];
}
