import { Component, OnInit, ViewChild, ElementRef, HostListener, signal, computed, inject, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { Toast } from 'primeng/toast';
import { ConfirmDialog } from 'primeng/confirmdialog';
import { Button } from 'primeng/button';
import { Tag } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService, ConfirmationService } from 'primeng/api';
import { TranslateService, TranslatePipe } from '@ngx-translate/core';
import { ToolbarComponent } from '../toolbar/toolbar.component';
import { NodeListComponent } from '../node-list/node-list.component';
import { LinkListComponent } from '../link-list/link-list.component';
import { NodeFormComponent } from '../node-form/node-form.component';
import { TopologyViewComponent } from '../topology-view/topology-view.component';
import { LabNode, NodeStatus } from '../../../../../backend/models/node.model';
import { LabLink } from '../../../../../backend/models/link.model';
import { NetworkService } from '../../services/network.service';
import { NodeService } from '../../services/node.service';
import { imageLabel } from '../../shared/image-options';

interface AddrRow  { name: string; state: string; ips: string; }
interface RouteRow { dest: string; via: string;   dev: string; }
interface NetworkInfo { addr: AddrRow[]; routes: RouteRow[]; }

@Component({
  selector: 'app-main-layout',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    ToolbarComponent, NodeListComponent, LinkListComponent, NodeFormComponent, TopologyViewComponent,
    Toast, ConfirmDialog, Button, Tag,
    TooltipModule, TranslatePipe,
  ],
  providers: [ConfirmationService],
  styleUrl: './main-layout.component.css',
  templateUrl: './main-layout.component.html',
})

export class MainLayoutComponent implements OnInit {
  @ViewChild(TopologyViewComponent) topologyView?: TopologyViewComponent;
  @ViewChild('sidebarBody') sidebarBodyRef?: ElementRef<HTMLElement>;

  private networkService      = inject(NetworkService);
  private nodeService         = inject(NodeService);
  private messageService      = inject(MessageService);
  private confirmationService = inject(ConfirmationService);
  private translate           = inject(TranslateService);

  showCreateDialog = false;
  showEditDialog   = false;

  // Sidebar width and node/link list split are both user-resizable via drag
  // handles — plain signals + document-level mouse listeners, same pattern
  // topology-view uses for pan/zoom dragging.
  sidebarWidth    = signal(260);
  nodeListPercent = signal(50);

  private sidebarDrag = { active: false, startX: 0, startWidth: 260 };
  private splitDrag   = { active: false, startY: 0, startPercent: 50, containerHeight: 0 };

  startSidebarResize(event: MouseEvent): void {
    this.sidebarDrag = { active: true, startX: event.clientX, startWidth: this.sidebarWidth() };
    event.preventDefault();
  }

  startSplitResize(event: MouseEvent): void {
    const containerHeight = this.sidebarBodyRef?.nativeElement.clientHeight ?? 0;
    this.splitDrag = { active: true, startY: event.clientY, startPercent: this.nodeListPercent(), containerHeight };
    event.preventDefault();
  }

  @HostListener('document:mousemove', ['$event'])
  onResizeMouseMove(event: MouseEvent): void {
    if (this.sidebarDrag.active) {
      const delta = event.clientX - this.sidebarDrag.startX;
      this.sidebarWidth.set(Math.min(480, Math.max(200, this.sidebarDrag.startWidth + delta)));
    }
    if (this.splitDrag.active && this.splitDrag.containerHeight > 0) {
      const delta = event.clientY - this.splitDrag.startY;
      const deltaPercent = (delta / this.splitDrag.containerHeight) * 100;
      this.nodeListPercent.set(Math.min(80, Math.max(20, this.splitDrag.startPercent + deltaPercent)));
    }
  }

  @HostListener('document:mouseup')
  onResizeMouseUp(): void {
    this.sidebarDrag.active = false;
    this.splitDrag.active = false;
  }

  readonly isElectron = !!window.electronAPI;

  networkInfo    = signal<NetworkInfo | null>(null);
  netInfoLoading = signal(false);
  netInfoTime    = signal<Date | null>(null);
  netInfoError   = signal<string | null>(null);

  constructor() {
    // Clear snapshot and auto-fetch whenever the selected node changes
    effect(() => {
      const id = this.selectedNodeId();
      untracked(() => {
        this.networkInfo.set(null);
        this.netInfoTime.set(null);
        this.netInfoError.set(null);
        if (id) {
          const node = this.selectedNode();
          if (node?.status === 'running') void this.fetchNetworkInfo();
        }
      });
    });
  }

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
  readonly imageLabel = imageLabel;

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

  async fetchNetworkInfo(): Promise<void> {
    const node = this.selectedNode();
    if (!node || node.status !== 'running' || !window.electronAPI) return;
    this.netInfoLoading.set(true);
    this.netInfoError.set(null);
    try {
      const info = await window.electronAPI.getNetworkInfo(node.id);
      this.networkInfo.set(info);
      this.netInfoTime.set(new Date());
    } catch (e) {
      this.netInfoError.set(e instanceof Error ? e.message : String(e));
    } finally {
      this.netInfoLoading.set(false);
    }
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
    // Assigning an interface to a link changes its connectedNodes even
    // without starting the node — links need reloading here too, not just
    // after start/stop.
    this.networkService.loadLinks().subscribe();
  }

  onNodeUpdated(): void {
    this.showEditDialog = false;
    this.messageService.add({ severity: 'success', summary: this.t('node.updated'), life: 3000 });
    this.networkService.loadLinks().subscribe();
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
            this.networkService.loadLinks().subscribe();
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
        this.clearNetSnapshot();
        void this.fetchNetworkInfo();
      },
      error: (e: Error) => { this.setLoading(node.id, false); this.showError(e); },
    });
  }

  onStop(): void {
    const node = this.selectedNode();
    if (!node) return;
    const stoppedId = node.id;
    this.setLoading(stoppedId, true);
    this.nodeService.stopNode(stoppedId).subscribe({
      next: () => {
        this.setLoading(stoppedId, false);
        this.messageService.add({ severity: 'info', summary: `"${node.name}"${this.t('node.stopped-suffix')}`, life: 3000 });
        this.networkService.loadLinks().subscribe();
        if (this.selectedNodeId() === stoppedId) this.clearNetSnapshot();
      },
      error: (e: Error) => { this.setLoading(stoppedId, false); this.showError(e); },
    });
  }

  onAttach(): void {
    const node = this.selectedNode();
    if (!node) return;
    if (!window.electronAPI) {
      this.messageService.add({ severity: 'warn', summary: this.t('node.only-electron'), life: 3000 });
      return;
    }
    window.electronAPI.openTerminalNative(node.id).catch((e: Error) => this.showError(e));
  }

  refreshTopology(): void {
    this.topologyView?.resetLayout();
  }

  deleteLink(name: string): void {
    this.networkService.deleteLink(name).subscribe({
      next: () => this.messageService.add({ severity: 'info', summary: `Link "${name}"${this.t('links.deleted-suffix')}`, life: 3000 }),
      error: (e: Error) => this.showError(e),
    });
  }

  statusSeverity(status: NodeStatus): 'success' | 'secondary' | 'info' | 'danger' | 'warn' {
    const map: Record<NodeStatus, 'success' | 'secondary' | 'info' | 'danger' | 'warn'> = {
      running: 'success', stopped: 'secondary', created: 'info', error: 'danger',
    };
    return map[status];
  }

  private clearNetSnapshot(): void {
    this.networkInfo.set(null);
    this.netInfoTime.set(null);
    this.netInfoError.set(null);
  }

  // Blocking errors (impossible action/needs review) deserve a dialog the
  // user closes explicitly, not a toast that disappears on its own after a
  // few seconds while they might still be reading it.
  private showError(e: Error): void {
    this.confirmationService.confirm({
      message: e.message,
      header: this.t('error.title'),
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: this.t('btn.ok'),
      rejectVisible: false,
      acceptButtonProps: { severity: 'danger' },
      accept: () => {},
    });
  }
}
