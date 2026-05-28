import {
  Component, Input, Output, EventEmitter,
  HostListener, ElementRef, ChangeDetectorRef,
  AfterViewInit, OnChanges, OnDestroy, SimpleChanges, inject,
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
export class TopologyViewComponent implements OnChanges, AfterViewInit, OnDestroy {
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

  private hasCentered = false;
  private svgEl!: SVGSVGElement;
  private wheelHandler!: (e: WheelEvent) => void;

  private el  = inject(ElementRef);
  private cdr = inject(ChangeDetectorRef);

  ngOnChanges(changes: SimpleChanges): void {
    if (this.svgEl && (changes['nodes'] || changes['links'])) this.centerView();
  }

  private centerView(): void {
    if (this.hasCentered || !this.nodes.length) return;
    const rect = this.svgEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // Wait until links are loaded if any node references one
    if (this.nodes.some(n => n.interfaces.some(i => i.linkName)) && !this.links.length) return;
    this.computeLayout();
    const pos = this.nodePositions;
    const minX = Math.min(...pos.map(n => n.px));
    const maxX = Math.max(...pos.map(n => n.px + NODE_W));
    const minY = Math.min(...pos.map(n => n.py));
    const maxY = Math.max(...pos.map(n => n.py + NODE_H));
    this.panX = rect.width  / 2 - ((minX + maxX) / 2) * this.scale;
    this.panY = rect.height / 2 - ((minY + maxY) / 2) * this.scale;
    this.hasCentered = true;
  }

  private computeLayout(): void {
    const n = this.nodes.length;
    if (n < 2) return;

    // Build adjacency (edge index pairs)
    const adj: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
    for (const link of this.links) {
      const idxs: number[] = [];
      this.nodes.forEach((nd, i) => {
        if (nd.interfaces.some(ifc => ifc.linkName === link.name)) idxs.push(i);
      });
      if (idxs.length >= 2) { adj[idxs[0]].add(idxs[1]); adj[idxs[1]].add(idxs[0]); }
    }

    // Circular seed positions (node centers relative to origin)
    const k = NODE_W + 50;
    const R = k * n / (2 * Math.PI);
    const pos = Array.from({ length: n }, (_, i) => ({
      x: R * Math.cos((2 * Math.PI * i) / n),
      y: R * Math.sin((2 * Math.PI * i) / n),
    }));

    let temp = k * 2;
    const dispX = new Float64Array(n);
    const dispY = new Float64Array(n);

    for (let iter = 0; iter < 300; iter++) {
      dispX.fill(0); dispY.fill(0);

      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const rep = k * k / dist;
          dispX[i] += dx / dist * rep; dispY[i] += dy / dist * rep;
          dispX[j] -= dx / dist * rep; dispY[j] -= dy / dist * rep;
        }
        // Weak gravity toward origin so disconnected nodes don't drift
        dispX[i] -= pos[i].x * 0.008;
        dispY[i] -= pos[i].y * 0.008;
      }

      for (let i = 0; i < n; i++) {
        for (const j of adj[i]) {
          if (j <= i) continue;
          const dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const attr = dist * dist / k;
          dispX[i] -= dx / dist * attr; dispY[i] -= dy / dist * attr;
          dispX[j] += dx / dist * attr; dispY[j] += dy / dist * attr;
        }
      }

      for (let i = 0; i < n; i++) {
        const len = Math.sqrt(dispX[i] * dispX[i] + dispY[i] * dispY[i]) || 1;
        pos[i].x += dispX[i] / len * Math.min(len, temp);
        pos[i].y += dispY[i] / len * Math.min(len, temp);
      }
      temp *= 0.92;
    }

    for (let i = 0; i < n; i++) {
      this.nodeOverrides.set(this.nodes[i].id, {
        px: pos[i].x - NODE_W / 2,
        py: pos[i].y - NODE_H / 2,
      });
    }
  }

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
      const cx1 = a.px + NODE_W / 2, cy1 = a.py + NODE_H / 2;
      const cx2 = b.px + NODE_W / 2, cy2 = b.py + NODE_H / 2;
      const p1 = this.borderPt(cx1, cy1, cx2, cy2);
      const p2 = this.borderPt(cx2, cy2, cx1, cy1);
      return [{ linkName: link.name, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }];
    });
  }

  private borderPt(cx: number, cy: number, tx: number, ty: number): { x: number; y: number } {
    const dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const s = Math.min(NODE_W / 2 / Math.abs(dx || 1e-9), NODE_H / 2 / Math.abs(dy || 1e-9));
    return { x: cx + dx * s, y: cy + dy * s };
  }

  edgeMid(e: Edge): { x: number; y: number } {
    return { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 };
  }

  edgeLabelWidth(name: string): number {
    return Math.max(40, name.length * 7 + 12);
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
    this.centerView();
    this.cdr.detectChanges();
  }

  ngOnDestroy(): void {
    this.svgEl?.removeEventListener('wheel', this.wheelHandler);
  }

  //Canvas pan

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

  //Node drag + click 

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

  //Shared document handlers 

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
