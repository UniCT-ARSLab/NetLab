import fs from 'fs';
import path from 'path';
import { LabNode } from '../models/node.model';
import { LabLink } from '../models/link.model';

interface DbState {
  nodes: LabNode[];
  links: LabLink[];
}

let filePath = '';
let state: DbState = { nodes: [], links: [] };

export const DbService = {
  init(userDataDir: string): void {
    filePath = path.join(userDataDir, 'netlab-data.json');
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        state = JSON.parse(raw);
        state.nodes ??= [];
        state.links ??= [];
      } catch {
        state = { nodes: [], links: [] };
      }
    }
  },

  save(): void {
    if (!filePath) return;
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
  },

  getNodes(): LabNode[] { return state.nodes; },
  getLinks(): LabLink[] { return state.links; },

  persistNodes(nodes: LabNode[]): void {
    state.nodes = nodes;
    this.save();
  },

  persistLinks(links: LabLink[]): void {
    state.links = links;
    this.save();
  },
};
