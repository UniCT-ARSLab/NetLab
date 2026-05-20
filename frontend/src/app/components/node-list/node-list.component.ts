import { Component, Input, Output, EventEmitter, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { Button } from 'primeng/button';
import { TranslatePipe } from '@ngx-translate/core';
import { NodeService } from '../../services/node.service';
import { LabNode } from '../../../../../backend/models/node.model';

@Component({
  selector: 'app-node-list',
  standalone: true,
  imports: [CommonModule, Button, TranslatePipe],
  styleUrl: './node-list.component.css',
  templateUrl: './node-list.component.html',
})
export class NodeListComponent implements OnInit {
  @Input() selectedNodeId: string | null = null;
  @Input() loadingNodeIds: Set<string> = new Set();
  @Output() nodeSelected    = new EventEmitter<LabNode>();
  @Output() createRequested = new EventEmitter<void>();

  private nodeService = inject(NodeService);
  nodes = toSignal(this.nodeService.nodes$, { initialValue: [] as LabNode[] });

  ngOnInit(): void {}
}
