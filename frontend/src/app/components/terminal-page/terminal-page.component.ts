import { Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { TerminalComponent } from '../terminal/terminal.component';
import { LabNode } from '../../../../../backend/models/node.model';

@Component({
  selector: 'app-terminal-page',
  standalone: true,
  imports: [TerminalComponent],
  styleUrl: './terminal-page.component.css',
  templateUrl: './terminal-page.component.html',
})
export class TerminalPageComponent implements OnInit {
  private route = inject(ActivatedRoute);
  node: LabNode | null = null;

  ngOnInit(): void {
    // angular loop warning
    const originalError = window.onerror;
    window.onerror = (msg, src, line, col, err) => {
      if (typeof msg === 'string' && msg.includes('ResizeObserver loop')) return true;
      return originalError ? originalError(msg, src, line, col, err) : false;
    };

    const p = this.route.snapshot.queryParams;
    this.node = {
      id: p['nodeId'] ?? '',
      name: p['nodeName'] ?? p['nodeId'] ?? 'Terminal',
      image: '',
      status: 'running',
      interfaces: [],
    };
  }

  close(): void {
    window.close();
  }
}