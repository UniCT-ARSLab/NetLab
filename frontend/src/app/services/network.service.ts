import { Injectable } from '@angular/core';
import { BehaviorSubject, from, Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { LabLink } from '../../../../backend/models/link.model';

@Injectable({ providedIn: 'root' })
export class NetworkService {
  private linksSubject = new BehaviorSubject<LabLink[]>([]);
  links$: Observable<LabLink[]> = this.linksSubject.asObservable();

  private get api() { return window.electronAPI; }

  loadLinks(): Observable<LabLink[]> {
    if (!this.api) return of([]);
    return from(this.api.listLinks()).pipe(
      tap((links) => this.linksSubject.next(links))
    );
  }

  createLink(name: string, type?: 'cable' | 'switch'): Observable<LabLink> {
    if (!this.api) return of({} as LabLink);
    return from(this.api.createLink(name, type)).pipe(
      tap((link) => this.linksSubject.next([...this.linksSubject.value, link]))
    );
  }

  deleteLink(name: string): Observable<void> {
    if (!this.api) return of(undefined);
    return from(this.api.deleteLink(name)).pipe(
      tap(() => {
        const filtered = this.linksSubject.value.filter((l) => l.name !== name);
        this.linksSubject.next(filtered);
      })
    );
  }
}
