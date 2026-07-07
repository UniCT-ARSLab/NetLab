import { Component, Input, Output, EventEmitter, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ToolbarModule } from 'primeng/toolbar';
import { ButtonModule } from 'primeng/button';
import { Divider } from 'primeng/divider';
import { TranslateService, TranslatePipe } from '@ngx-translate/core';
import { LabNode } from '../../../../../backend/models/node.model';

@Component({
  selector: 'app-toolbar',
  standalone: true,
  imports: [CommonModule, ToolbarModule, ButtonModule, Divider, TranslatePipe],
  styleUrl: './toolbar.component.css',
  templateUrl: './toolbar.component.html',
})
export class ToolbarComponent implements OnInit {
  @Input() selectedNode: LabNode | null = null;
  @Input() isLoading = false;

  @Output() createClicked  = new EventEmitter<void>();
  @Output() editClicked    = new EventEmitter<void>();
  @Output() deleteClicked  = new EventEmitter<void>();
  @Output() startClicked   = new EventEmitter<void>();
  @Output() stopClicked    = new EventEmitter<void>();
  @Output() attachClicked  = new EventEmitter<void>();

  private translate = inject(TranslateService);

  readonly platform = window.electronAPI?.platform ?? 'web';
  readonly isMaximized = signal(false);
  readonly lang = signal(localStorage.getItem('netlab-lang') ?? 'it');

  ngOnInit(): void {
    this.translate.use(this.lang());
    window.electronAPI?.onWindowMaximizeChange((maximized) => this.isMaximized.set(maximized));
  }

  switchLang(): void {
    const next = this.lang() === 'it' ? 'en' : 'it';
    localStorage.setItem('netlab-lang', next);
    this.lang.set(next);
    this.translate.use(next);
  }

  minimize(): void        { window.electronAPI?.minimizeWindow(); }
  toggleMaximize(): void  {
    if (this.isMaximized()) window.electronAPI?.unmaximizeWindow();
    else window.electronAPI?.maximizeWindow();
  }
  closeWin(): void        { window.electronAPI?.closeWindow(); }

  get canStart(): boolean  {
    return !this.isLoading && (this.selectedNode?.status === 'created' || this.selectedNode?.status === 'stopped');
  }
  get canStop(): boolean   { return !this.isLoading && this.selectedNode?.status === 'running'; }
  get canAttach(): boolean { return !this.isLoading && this.selectedNode?.status === 'running'; }
  get canEdit(): boolean   { return !!this.selectedNode && !this.isLoading; }
  get canDelete(): boolean { return !!this.selectedNode && !this.isLoading; }
}
