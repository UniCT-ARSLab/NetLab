import {
  Component, Input, Output, EventEmitter, inject, computed, OnChanges, SimpleChanges, ChangeDetectorRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { Dialog } from 'primeng/dialog';
import { Button } from 'primeng/button';
import { Select } from 'primeng/select';
import { InputText } from 'primeng/inputtext';
import { InputNumber } from 'primeng/inputnumber';
import { Divider } from 'primeng/divider';
import { MessageService } from 'primeng/api';
import { TooltipModule } from 'primeng/tooltip';
import { TranslateService, TranslatePipe } from '@ngx-translate/core';
import { NodeService } from '../../services/node.service';
import { NetworkService } from '../../services/network.service';
import { LabNode } from '../../../../../backend/models/node.model';
import { LabLink } from '../../../../../backend/models/link.model';

interface InterfaceRow { name: string; linkName: string; }
interface MountRow     { hostPath: string; containerPath: string; }

@Component({
  selector: 'app-node-form',
  standalone: true,
  imports: [CommonModule, FormsModule, Dialog, Button, Select, InputText, InputNumber, Divider, TooltipModule, TranslatePipe],
  styleUrl: './node-form.component.css',
  templateUrl: './node-form.component.html',
})
export class NodeFormComponent implements OnChanges {
  @Input() visible = false;
  @Input() editNode: LabNode | null = null;
  @Output() visibleChange = new EventEmitter<boolean>();
  @Output() nodeCreated   = new EventEmitter<void>();
  @Output() nodeUpdated   = new EventEmitter<void>();

  private nodeService    = inject(NodeService);
  private networkService = inject(NetworkService);
  private messageService = inject(MessageService);
  private translate      = inject(TranslateService);
  private cdr            = inject(ChangeDetectorRef);

  links = toSignal(this.networkService.links$, { initialValue: [] as LabLink[] });
  private allNodes = toSignal(this.nodeService.nodes$, { initialValue: [] as LabNode[] });

  linkOptions = computed(() => {
    // Count interface-to-link assignments from every node except the one being edited
    const usage = new Map<string, number>();
    for (const node of this.allNodes()) {
      if (node.id === this.editNode?.id) continue;
      for (const iface of node.interfaces) {
        if (iface.linkName) usage.set(iface.linkName, (usage.get(iface.linkName) ?? 0) + 1);
      }
    }
    return [
      { label: this.translate.instant('form.no-link-option'), value: '', disabled: false },
      ...this.links().map(l => ({
        label: l.name,
        value: l.name,
        disabled: (usage.get(l.name) ?? 0) >= 2,
      })),
    ];
  });

  readonly imageOptions = [
    { label: 'kathara/base', value: 'kathara/base' },
    { label: 'alpine',       value: 'alpine' },
  ];

  name       = '';
  image      = 'kathara/base';
  cpuLimit   = 1.0;
  memoryMb   = 256;
  interfaces: InterfaceRow[] = [];
  mounts: MountRow[] = [];

  get dialogHeader(): string {
    return this.editNode
      ? this.translate.instant('form.edit-title-prefix') + this.editNode.name
      : this.translate.instant('form.create-title');
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['visible']?.currentValue === true) {
      if (this.editNode) {
        this.name       = this.editNode.name;
        this.image      = this.editNode.image;
        this.cpuLimit   = this.editNode.cpuLimit  ?? 1.0;
        this.memoryMb   = this.editNode.memoryMb  ?? 256;
        this.interfaces = this.editNode.interfaces.map((i) => ({ ...i }));
        this.mounts     = (this.editNode.mounts ?? []).map((m) => ({ ...m }));
      } else {
        this.reset();
      }
    }
  }

  addInterface(): void { this.interfaces.push({ name: `eth${this.interfaces.length}`, linkName: '' }); }
  removeInterface(index: number): void { this.interfaces.splice(index, 1); }

  async addMount(): Promise<void> {
    try {
      const hostPath = await window.electronAPI.openFolderDialog();
      if (!hostPath) return;
      const folderName = hostPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'shared';
      this.mounts = [...this.mounts, { hostPath, containerPath: `/shared/${folderName}` }];
      this.cdr.detectChanges();
    } catch { /* dialog closed or unavailable */ }
  }

  async browseHostPath(index: number): Promise<void> {
    try {
      const hostPath = await window.electronAPI.openFolderDialog();
      if (!hostPath) return;
      const folderName = hostPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'shared';
      const prevFolderName = this.mounts[index].hostPath
        .replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
      this.mounts = this.mounts.map((m, i) =>
        i === index
          ? {
              hostPath,
              containerPath: m.containerPath === `/shared/${prevFolderName}`
                ? `/shared/${folderName}`
                : m.containerPath,
            }
          : m,
      );
      this.cdr.detectChanges();
    } catch { /* dialog closed or unavailable */ }
  }

  removeMount(index: number): void { this.mounts.splice(index, 1); }
  isValid(): boolean { return this.name.trim().length > 0; }

  submit(): void {
    if (!this.isValid()) return;
    const params = {
      name:       this.name.trim(),
      image:      this.image,
      cpuLimit:   this.cpuLimit,
      memoryMb:   this.memoryMb,
      interfaces: this.interfaces.filter((i) => i.name.trim()).map((i) => ({ name: i.name.trim(), linkName: i.linkName })),
      mounts:     this.mounts.filter((m) => m.hostPath && m.containerPath),
    };

    if (this.editNode) {
      this.nodeService.updateNode(this.editNode.id, params).subscribe({
        next: () => this.nodeUpdated.emit(),
        error: (e: Error) => this.messageService.add({
          severity: 'error', summary: this.translate.instant('error.title'), detail: e.message, life: 5000,
        }),
      });
    } else {
      this.nodeService.createNode(params).subscribe({
        next: () => { this.reset(); this.nodeCreated.emit(); },
        error: (e: Error) => this.messageService.add({
          severity: 'error', summary: this.translate.instant('error.title'), detail: e.message, life: 5000,
        }),
      });
    }
  }

  private reset(): void {
    this.name = ''; this.image = 'kathara/base';
    this.cpuLimit = 1.0; this.memoryMb = 256;
    this.interfaces = []; this.mounts = [];
  }
}
