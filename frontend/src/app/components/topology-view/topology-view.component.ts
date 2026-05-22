import {
  Component, Input, Output, EventEmitter,
  HostListener, ElementRef, ChangeDetectorRef,
  AfterViewInit, OnDestroy, inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { LabNode } from '../../../../../backend/models/node.model';
import { LabLink } from '../../../../../backend/models/link.model';

const NODE_W   = 160;
const NODE_H   = 56;
const COL_W    = 230;
const ROW_H    = 130;
const COLS     = 3;
const PAD      = 40;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;

interface NodePos extends LabNode { px: number; py: number; }
interface Edge { linkName: string; x1: number; y1: number; x2: number; y2: number; }

@Component({
  selector: 'app-topology-view',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './topology-view.component.html',
  styleUrl: './topology-view.component.css',
})
export class TopologyViewComponent implements AfterViewInit, OnDestroy {
  @Input() nodes: LabNode[] = [];
  @Input() links: LabLink[] = [];
  @Input() selectedNodeId: string | null = null;
  @Output() nodeSelected = new EventEmitter<LabNode>();
  @Output() deselected   = new EventEmitter<void>();

  readonly NODE_W = NODE_W;
  readonly NODE_H = NODE_H;

  // Canvas pan/zoom
  panX      = PAD;
  panY      = PAD;
  scale     = 1;
  isDragging = false;

  private hasDragged  = false;
  private dragStart   = { x: 0, y: 0, panX: 0, panY: 0 };

  // Node drag
  private draggingNodeId: string | null = null;
  private nodeDragged    = false;
  private nodeDragOffset = { x: 0, y: 0 };
  private nodeOverrides  = new Map<string, { px: number; py: number }>();

  private svgEl!: SVGSVGElement;
  private wheelHandler!: (e: WheelEvent) => void;

  private el  = inject(ElementRef);
  private cdr = inject(ChangeDetectorRef);

  get canvasTransform(): string {
    return `translate(${this.panX},${this.panY}) scale(${this.scale})`;
  }

  get nodePositions(): NodePos[] {
    return this.nodes.map((n, i) => {
      const ov = this.nodeOverrides.get(n.id);
      return {
        ...n,
        px: ov?.px ?? (i % COLS) * COL_W,
        py: ov?.py ?? Math.floor(i / COLS) * ROW_H,
      };
    });
  }

  get edges(): Edge[] {
    const pos = this.nodePositions;
    return this.links.flatMap(link => {
      const connected = pos.filter(n => n.interfaces.some(i => i.linkName === link.name));
      if (connected.length < 2) return [];
      const [a, b] = connected;
      return [{
        linkName: link.name,
        x1: a.px + NODE_W / 2, y1: a.py + NODE_H / 2,
        x2: b.px + NODE_W / 2, y2: b.py + NODE_H / 2,
      }];
    });
  }

  edgeMid(e: Edge): { x: number; y: number } {
    return { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 };
  }

  ngAfterViewInit(): void {
    this.svgEl = this.el.nativeElement.querySelector('svg') as SVGSVGElement;
    this.wheelHandler = (e: WheelEvent) => {
      e.preventDefault();
      const factor   = e.deltaY > 0 ? 0.9 : 1.1;
      const newScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.scale * factor));
      const rect     = this.svgEl.getBoundingClientRect();
      const mx       = e.clientX - rect.left;
      const my       = e.clientY - rect.top;
      const ratio    = newScale / this.scale;
      this.panX  = mx - ratio * (mx - this.panX);
      this.panY  = my - ratio * (my - this.panY);
      this.scale = newScale;
      this.cdr.detectChanges();
    };
    this.svgEl.addEventListener('wheel', this.wheelHandler, { passive: false });
  }

  ngOnDestroy(): void {
    this.svgEl?.removeEventListener('wheel', this.wheelHandler);
  }

  // ── Canvas pan ──────────────────────────────────────

  onSvgMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    this.isDragging = true;
    this.hasDragged = false;
    this.dragStart  = { x: event.clientX, y: event.clientY, panX: this.panX, panY: this.panY };
    event.preventDefault();
  }

  onSvgClick(): void {
    if (!this.hasDragged) this.deselected.emit();
  }

  // ── Node drag + click ───────────────────────────────

  onNodeMouseDown(node: NodePos, event: MouseEvent): void {
    event.stopPropagation(); // prevent canvas pan
    if (event.button !== 0) return;
    const rect           = this.svgEl.getBoundingClientRect();
    const cx             = (event.clientX - rect.left - this.panX) / this.scale;
    const cy             = (event.clientY - rect.top  - this.panY) / this.scale;
    this.draggingNodeId  = node.id;
    this.nodeDragged     = false;
    this.nodeDragOffset  = { x: cx - node.px, y: cy - node.py };
    event.preventDefault();
  }

  onNodeClick(node: NodePos, event: MouseEvent): void {
    event.stopPropagation();
    if (this.nodeDragged) return;
    this.nodeSelected.emit(node);
  }

  // ── Shared document handlers ────────────────────────

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    if (this.draggingNodeId) {
      const rect = this.svgEl.getBoundingClientRect();
      const cx   = (event.clientX - rect.left - this.panX) / this.scale;
      const cy   = (event.clientY - rect.top  - this.panY) / this.scale;
      this.nodeOverrides.set(this.draggingNodeId, {
        px: cx - this.nodeDragOffset.x,
        py: cy - this.nodeDragOffset.y,
      });
      this.nodeDragged = true;
      return;
    }
    if (!this.isDragging) return;
    const dx = event.clientX - this.dragStart.x;
    const dy = event.clientY - this.dragStart.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.hasDragged = true;
    this.panX = this.dragStart.panX + dx;
    this.panY = this.dragStart.panY + dy;
  }

  @HostListener('document:mouseup')
  onMouseUp(): void {
    this.draggingNodeId = null;
    this.isDragging     = false;
  }
}
