import { Component, OnInit, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { Toast } from 'primeng/toast';
import { Dialog } from 'primeng/dialog';
import { ConfirmDialog } from 'primeng/confirmdialog';
import { Button } from 'primeng/button';
import { InputText } from 'primeng/inputtext';
import { Divider } from 'primeng/divider';
import { Tag } from 'primeng/tag';
import { MessageService, ConfirmationService } from 'primeng/api';
import { TranslateService, TranslatePipe } from '@ngx-translate/core';
import { ToolbarComponent } from '../toolbar/toolbar.component';
import { NodeListComponent } from '../node-list/node-list.component';
import { NodeFormComponent } from '../node-form/node-form.component';
import { TopologyViewComponent } from '../topology-view/topology-view.component';
import { LabNode, NodeStatus } from '../../../../../backend/models/node.model';
import { LabLink } from '../../../../../backend/models/link.model';
import { NetworkService } from '../../services/network.service';
import { NodeService } from '../../services/node.service';

@Component({
  selector: 'app-main-layout',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    ToolbarComponent, NodeListComponent, NodeFormComponent, TopologyViewComponent,
    Toast, Dialog, ConfirmDialog, Button, InputText, Divider, Tag,
    TranslatePipe,
  ],
  providers: [ConfirmationService],
  styleUrl: './main-layout.component.css',
  templateUrl: './main-layout.component.html',
})
export class MainLayoutComponent implements OnInit {
  private networkService      = inject(NetworkService);
  private nodeService         = inject(NodeService);
  private messageService      = inject(MessageService);
  private confirmationService = inject(ConfirmationService);
  private translate           = inject(TranslateService);

  showCreateDialog = false;
  showEditDialog   = false;
  showLinkDialog   = false;
  newLinkName = '';

  dockerStatus = signal<'checking' | 'ok' | 'unavailable'>('checking');

  nodes = toSignal(this.nodeService.nodes$, { initialValue: [] as LabNode[] });
  links = toSignal(this.networkService.links$, { initialValue: [] as LabLink[] });

  selectedNodeId = signal<string | null>(null);
  selectedNode = computed(() =>
    this.nodes().find((n) => n.id === this.selectedNodeId()) ?? null
  );

  loadingNodeIds = signal(new Set<string>());
  isSelectedNodeLoading = computed(() => this.loadingNodeIds().has(this.selectedNodeId() ?? ''));

  private t(key: string): string { return this.translate.instant(key); }

  private setLoading(id: string, on: boolean): void {
    this.loadingNodeIds.update(s => { const n = new Set(s); on ? n.add(id) : n.delete(id); return n; });
  }

  ngOnInit(): void {
    if (window.electronAPI) {
      window.electronAPI.checkDocker().then((ok) => {
        this.dockerStatus.set(ok ? 'ok' : 'unavailable');
        if (ok) this.loadData();
      });
      window.electronAPI.onDockerUnavailable(() => this.dockerStatus.set('unavailable'));
      window.electronAPI.onDataReady(() => this.loadData());
    } else {
      this.dockerStatus.set('ok');
      this.loadData();
    }
  }

  retryDockerCheck(): void {
    this.dockerStatus.set('checking');
    window.electronAPI.checkDocker().then((ok) => {
      this.dockerStatus.set(ok ? 'ok' : 'unavailable');
      if (ok) this.loadData();
    });
  }

  private loadData(): void {
    this.nodeService.loadNodes().subscribe();
    this.networkService.loadLinks().subscribe();
  }

  onNodeSelected(node: LabNode): void {
    this.selectedNodeId.set(node.id === this.selectedNodeId() ? null : node.id);
  }

  openCreateDialog(): void { this.showCreateDialog = true; }
  openEditDialog(): void   { if (this.selectedNode()) this.showEditDialog = true; }

  onNodeCreated(): void {
    this.showCreateDialog = false;
    this.messageService.add({ severity: 'success', summary: this.t('node.created'), life: 3000 });
  }

  onNodeUpdated(): void {
    this.showEditDialog = false;
    this.messageService.add({ severity: 'success', summary: this.t('node.updated'), life: 3000 });
  }

  onDelete(): void {
    const node = this.selectedNode();
    if (!node) return;
    this.confirmationService.confirm({
      message:     `${this.t('node.delete-prefix')}"${node.name}"?`,
      header:      this.t('node.delete-title'),
      icon:        'pi pi-exclamation-triangle',
      acceptLabel: this.t('btn.delete'),
      rejectLabel: this.t('btn.cancel'),
      acceptButtonProps: { severity: 'danger' },
      accept: () => {
        this.setLoading(node.id, true);
        this.nodeService.deleteNode(node.id).subscribe({
          next: () => {
            this.setLoading(node.id, false);
            this.selectedNodeId.set(null);
            this.messageService.add({ severity: 'info', summary: `"${node.name}"${this.t('node.deleted-suffix')}`, life: 3000 });
          },
          error: (e: Error) => { this.setLoading(node.id, false); this.showError(e); },
        });
      },
    });
  }

  onStart(): void {
    const node = this.selectedNode();
    if (!node) return;
    this.setLoading(node.id, true);
    this.nodeService.startNode(node.id).subscribe({
      next: () => {
        this.setLoading(node.id, false);
        this.messageService.add({ severity: 'success', summary: `"${node.name}"${this.t('node.started-suffix')}`, life: 3000 });
        this.networkService.loadLinks().subscribe();
      },
      error: (e: Error) => { this.setLoading(node.id, false); this.showError(e); },
    });
  }

  onStop(): void {
    const node = this.selectedNode();
    if (!node) return;
    this.setLoading(node.id, true);
    this.nodeService.stopNode(node.id).subscribe({
      next: () => {
        this.setLoading(node.id, false);
        this.messageService.add({ severity: 'info', summary: `"${node.name}"${this.t('node.stopped-suffix')}`, life: 3000 });
        this.networkService.loadLinks().subscribe();
      },
      error: (e: Error) => { this.setLoading(node.id, false); this.showError(e); },
    });
  }

  onAttach(): void {
    const node = this.selectedNode();
    if (!node) return;
    if (!window.electronAPI) {
      this.messageService.add({ severity: 'warn', summary: this.t('node.only-electron'), life: 3000 });
      return;
    }
    window.electronAPI.openTerminalWindow(node.id, node.name);
  }

  openLinkDialog(): void { this.showLinkDialog = true; this.newLinkName = ''; }

  createLink(): void {
    const name = this.newLinkName.trim();
    if (!name) return;
    this.networkService.createLink(name).subscribe({
      next: () => {
        this.messageService.add({ severity: 'success', summary: `Link "${name}"${this.t('links.created-suffix')}`, life: 3000 });
        this.newLinkName = '';
      },
      error: (e: Error) => this.showError(e),
    });
  }

  deleteLink(name: string): void {
    this.networkService.deleteLink(name).subscribe({
      next: () => this.messageService.add({ severity: 'info', summary: `Link "${name}"${this.t('links.deleted-suffix')}`, life: 3000 }),
    });
  }

  statusSeverity(status: NodeStatus): 'success' | 'secondary' | 'info' | 'danger' | 'warn' {
    const map: Record<NodeStatus, 'success' | 'secondary' | 'info' | 'danger' | 'warn'> = {
      running: 'success', stopped: 'secondary', created: 'info', error: 'danger',
    };
    return map[status];
  }

  private showError(e: Error): void {
    this.messageService.add({ severity: 'error', summary: this.t('error.title'), detail: e.message, life: 5000 });
  }
}
