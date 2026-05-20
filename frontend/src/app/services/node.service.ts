import { Injectable } from '@angular/core';
import { BehaviorSubject, from, Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { LabNode } from '../../../../backend/models/node.model';
import { CreateNodeParams } from '../../../../backend/models/ipc.model';

@Injectable({ providedIn: 'root' })
export class NodeService {
  private nodesSubject = new BehaviorSubject<LabNode[]>([]);
  nodes$: Observable<LabNode[]> = this.nodesSubject.asObservable();

  private get api() { return window.electronAPI; }

  loadNodes(): Observable<LabNode[]> {
    if (!this.api) return of([]);
    return from(this.api.listNodes()).pipe(
      tap((nodes) => this.nodesSubject.next(nodes))
    );
  }

  createNode(params: CreateNodeParams): Observable<LabNode> {
    if (!this.api) return of({} as LabNode);
    return from(this.api.createNode(params)).pipe(
      tap((node) => this.nodesSubject.next([...this.nodesSubject.value, node]))
    );
  }

  updateNode(id: string, params: CreateNodeParams): Observable<LabNode> {
    if (!this.api) return of({} as LabNode);
    return from(this.api.updateNode(id, params)).pipe(
      tap((updated) => this.updateLocal(updated))
    );
  }

  startNode(id: string): Observable<LabNode> {
    if (!this.api) return of({} as LabNode);
    return from(this.api.startNode(id)).pipe(
      tap((updated) => this.updateLocal(updated))
    );
  }

  stopNode(id: string): Observable<LabNode> {
    if (!this.api) return of({} as LabNode);
    return from(this.api.stopNode(id)).pipe(
      tap((updated) => this.updateLocal(updated))
    );
  }

  deleteNode(id: string): Observable<void> {
    if (!this.api) return of(undefined);
    return from(this.api.deleteNode(id)).pipe(
      tap(() => {
        const filtered = this.nodesSubject.value.filter((n) => n.id !== id);
        this.nodesSubject.next(filtered);
      })
    );
  }

  private updateLocal(updated: LabNode): void {
    const nodes = this.nodesSubject.value.map((n) =>
      n.id === updated.id ? updated : n
    );
    this.nodesSubject.next(nodes);
  }
}
