import {
  Component, Input, Output, EventEmitter, OnDestroy,
  ElementRef, ViewChild, AfterViewInit, inject, signal,
  ChangeDetectorRef
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TranslateService, TranslatePipe } from '@ngx-translate/core';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { Subscription } from 'rxjs';
import { TerminalService } from '../../services/terminal.service';
import { LabNode } from '../../../../../backend/models/node.model';

@Component({
  selector: 'app-terminal',
  standalone: true,
  imports: [CommonModule, TranslatePipe],
  styleUrl: './terminal.component.css',
  templateUrl: './terminal.component.html',
})
export class TerminalComponent implements AfterViewInit, OnDestroy {
  @Input() node!: LabNode;
  @Input() autoCloseOnExit = false;
  @Output() closed = new EventEmitter<void>();
  @ViewChild('terminalEl') terminalEl!: ElementRef<HTMLDivElement>;

  private xterm!: Terminal;
  private fitAddon!: FitAddon;
  private terminalId!: string;
  private subs = new Subscription();
  private resizeObserver!: ResizeObserver;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  private terminalService = inject(TerminalService);
  private translate       = inject(TranslateService);
  private cdr             = inject(ChangeDetectorRef);

  readonly platform = window.electronAPI?.platform ?? 'web';
  sessionEnded = signal(false);
  stopping     = signal(false);

  async ngAfterViewInit(): Promise<void> {
    this.xterm = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      lineHeight: 1.2,
      fontFamily: '"Cascadia Code", "Fira Code", monospace',
      scrollOnUserInput: true,
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor:     '#aeafad',
      },
    });

    this.fitAddon = new FitAddon();
    this.xterm.loadAddon(this.fitAddon);
    this.xterm.open(this.terminalEl.nativeElement);

    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    this.fitAddon.fit();

    this.terminalId = `term_${this.node.id}`;

    this.subs.add(
      this.terminalService.output$(this.terminalId).subscribe((data) => {
        this.xterm.write(data, () => this.xterm.scrollToBottom());
      })
    );

    this.subs.add(
      this.terminalService.stopping$(this.terminalId).subscribe(() => {
        this.stopping.set(true);
        this.xterm.options.disableStdin = true;
        this.cdr.detectChanges();
      })
    );

    this.subs.add(
      this.terminalService.closed$(this.terminalId).subscribe(() => {
        this.stopping.set(false);
        this.sessionEnded.set(true);
        this.cdr.detectChanges();
        this.xterm.write(`\r\n\x1b[90m${this.translate.instant('terminal.session-ended')}\x1b[0m\r\n`);
        if (this.autoCloseOnExit) this.closed.emit();
      })
    );

    await this.terminalService.open(this.node.id, this.xterm.cols, this.xterm.rows);

    this.xterm.focus();
    this.xterm.onData((data) => {
      this.terminalService.sendInput(this.terminalId, data);
    });

    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        try {
          this.fitAddon.fit();
          if (this.terminalId) {
            this.terminalService.resize(this.terminalId, this.xterm.cols, this.xterm.rows);
          }
        } catch { }
      }, 60);
    });
    this.resizeObserver.observe(this.terminalEl.nativeElement);
  }

  onClose(): void {
    if (this.terminalId) this.terminalService.close(this.terminalId);
    this.closed.emit();
  }

  ngOnDestroy(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.subs.unsubscribe();
    this.resizeObserver?.disconnect();
    this.xterm?.dispose();
  }
}
