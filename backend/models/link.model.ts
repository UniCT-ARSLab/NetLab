export interface LabLink {
  name: string;             // nome del dominio di collisione
  dockerNetworkId?: string;
  connectedNodes: string[]; // id dei nodi collegati
}
