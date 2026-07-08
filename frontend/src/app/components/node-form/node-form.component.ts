import {
  Component, Input, Output, EventEmitter, inject, computed, OnChanges, SimpleChanges, ChangeDetectorRef,
  ElementRef, ViewChild,
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
import { ToggleSwitch } from 'primeng/toggleswitch';
import { Checkbox } from 'primeng/checkbox';
import { ConfirmationService } from 'primeng/api';
import { TooltipModule } from 'primeng/tooltip';
import { TranslateService, TranslatePipe } from '@ngx-translate/core';
import { NodeService } from '../../services/node.service';
import { NetworkService } from '../../services/network.service';
import { LabNode } from '../../../../../backend/models/node.model';
import { LabLink } from '../../../../../backend/models/link.model';
import { IMAGE_OPTIONS } from '../../shared/image-options';
import { parseAppError, translateAppError } from '../../shared/app-error';

interface InterfaceRow { name: string; linkName: string; }
interface MountRow     { hostPath: string; containerPath: string; }

@Component({
  selector: 'app-node-form',
  standalone: true,
  imports: [CommonModule, FormsModule, Dialog, Button, Select, InputText, InputNumber, Divider, ToggleSwitch, Checkbox, TooltipModule, TranslatePipe],
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
  private confirmationService = inject(ConfirmationService);
  private translate      = inject(TranslateService);
  private cdr            = inject(ChangeDetectorRef);

  @ViewChild('submitBtn', { read: ElementRef }) submitBtnRef?: ElementRef<HTMLElement>;
  private shakeTimeout?: ReturnType<typeof setTimeout>;

  links = toSignal(this.networkService.links$, { initialValue: [] as LabLink[] });
  private allNodes = toSignal(this.nodeService.nodes$, { initialValue: [] as LabNode[] });

  // Per-interface options: full links are removed entirely,
  // except when the link is already assigned to THIS interface (preserve current value).
  linkOptionsFor(iface: InterfaceRow): Array<{ label: string; value: string }> {
    const usage = new Map<string, number>();
    for (const node of this.allNodes()) {
      if (node.id === this.editNode?.id) continue;
      for (const i of node.interfaces) {
        if (i.linkName) usage.set(i.linkName, (usage.get(i.linkName) ?? 0) + 1);
      }
    }
    return [
      { label: this.translate.instant('form.no-link-option'), value: '' },
      ...this.links()
        .filter(l => (usage.get(l.name) ?? 0) < 2 || l.name === iface.linkName)
        .map(l => ({ label: l.name, value: l.name })),
    ];
  }

  readonly imageOptions = IMAGE_OPTIONS;

  name           = '';
  nameError      = false;
  nameErrorShake = false;
  image          = 'nicolaka/netshoot';
  showAdvanced = false;
  limitCpu       = false;
  limitMemory    = false;
  cpuLimit       = 1.0;
  memoryMb       = 256;
  interfaces: InterfaceRow[] = [];
  mounts: MountRow[] = [];
  internetFacing = false;
  wanIfaceName   = 'eth_wan';
  isSwitch       = false;

  get dialogHeader(): string {
    return this.editNode
      ? this.translate.instant('form.edit-title-prefix') + this.editNode.name
      : this.translate.instant('form.create-title');
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['visible']?.currentValue === true) {
      this.nameError = false;
      this.nameErrorShake = false;
      if (this.editNode) {
        this.name       = this.editNode.name;
        this.image      = this.editNode.image;
        this.limitCpu    = this.editNode.cpuLimit != null;
        this.limitMemory = this.editNode.memoryMb != null;
        this.cpuLimit    = this.editNode.cpuLimit  ?? 1.0;
        this.memoryMb    = this.editNode.memoryMb  ?? 256;
        this.showAdvanced = this.limitCpu || this.limitMemory;
        this.interfaces    = this.editNode.interfaces.map((i) => ({ ...i }));
        this.mounts        = (this.editNode.mounts ?? []).map((m) => ({ ...m }));
        this.internetFacing = this.editNode.internetFacing ?? false;
        this.wanIfaceName   = this.editNode.wanIfaceName  ?? 'eth_wan';
        this.isSwitch       = this.editNode.isSwitch ?? false;
      } else {
        this.reset();
      }
    }
  }

  // Naming is fully our convention, not user-editable: pick the lowest free
  // ethN so removing an interface and adding a new one can never collide
  // with a name still in use by another row.
  addInterface(): void {
    const used = new Set(this.interfaces.map(i => i.name));
    let n = 0;
    while (used.has(`eth${n}`)) n++;
    this.interfaces.push({ name: `eth${n}`, linkName: '' });
  }
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
    const trimmedName = this.name.trim();
    const duplicate = this.allNodes().some(n => n.id !== this.editNode?.id && n.name === trimmedName);
    if (duplicate) {
      this.triggerNameError();
      return;
    }
    const params = {
      name:       trimmedName,
      image:      this.image,
      cpuLimit:   this.limitCpu ? this.cpuLimit : undefined,
      memoryMb:   this.limitMemory ? this.memoryMb : undefined,
      interfaces:     this.interfaces.filter((i) => i.name.trim()).map((i) => ({ name: i.name.trim(), linkName: i.linkName })),
      mounts:         this.mounts.filter((m) => m.hostPath && m.containerPath),
      internetFacing: this.internetFacing,
      wanIfaceName:   this.internetFacing ? (this.wanIfaceName.trim() || 'eth_wan') : undefined,
      isSwitch:       this.isSwitch,
    };

    if (this.editNode) {
      this.nodeService.updateNode(this.editNode.id, params).subscribe({
        next: () => this.nodeUpdated.emit(),
        error: (e: Error) => this.handleSubmitError(e),
      });
    } else {
      this.nodeService.createNode(params).subscribe({
        next: () => { this.reset(); this.nodeCreated.emit(); },
        error: (e: Error) => this.handleSubmitError(e),
      });
    }
  }

  // Same-name race between two windows: the client-side check above misses
  // it, but the backend still rejects — surface it the same inline way
  // instead of falling back to the generic modal.
  private handleSubmitError(e: Error): void {
    if (parseAppError(e)?.code === 'NODE_NAME_DUPLICATE') {
      this.triggerNameError();
      return;
    }
    this.showError(e);
  }

  // Direct DOM classList + forced reflow instead of an Angular class
  // binding: replays every time even on back-to-back submits, and doesn't
  // depend on the change-detection timing of whatever triggered submit().
  private triggerNameError(): void {
    this.nameError = true;
    this.nameErrorShake = true;
    const el = this.submitBtnRef?.nativeElement;
    if (el) {
      el.classList.remove('btn-shake');
      void el.offsetWidth;
      el.classList.add('btn-shake');
    }
    clearTimeout(this.shakeTimeout);
    this.shakeTimeout = setTimeout(() => {
      this.nameErrorShake = false;
      el?.classList.remove('btn-shake');
    }, 400);
  }

  private showError(e: Error): void {
    this.confirmationService.confirm({
      message: translateAppError(e, this.translate),
      header: this.translate.instant('error.title'),
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: this.translate.instant('btn.ok'),
      rejectVisible: false,
      acceptButtonProps: { severity: 'danger' },
      accept: () => {},
    });
  }

  private reset(): void {
    this.name = ''; this.nameError = false; this.image = 'nicolaka/netshoot';
    this.showAdvanced = false;
    this.limitCpu = false; this.limitMemory = false;
    this.cpuLimit = 1.0; this.memoryMb = 256;
    this.interfaces = []; this.mounts = [];
    this.internetFacing = false;
    this.wanIfaceName   = 'eth_wan';
    this.isSwitch       = false;
  }
}
