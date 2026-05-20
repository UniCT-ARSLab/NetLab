import { Injectable, OnDestroy } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';

export interface TerminalOutput {
  terminalId: string;
  data: string;
}

@Injectable({ providedIn: 'root' })
export class TerminalService implements OnDestroy {
  // open terminals streams
  private outputSubject   = new Subject<TerminalOutput>();
  private closedSubject   = new Subject<string>();
  private stoppingSubject = new Subject<string>();

  constructor() {
    window.electronAPI.onTerminalOutput((terminalId, data) => {
      this.outputSubject.next({ terminalId, data });
    });
    window.electronAPI.onTerminalClosed((terminalId) => {
      this.closedSubject.next(terminalId);
    });
    window.electronAPI.onTerminalStopping((terminalId) => {
      this.stoppingSubject.next(terminalId);
    });
  }

  async open(nodeId: string, cols: number, rows: number): Promise<string> {
    return window.electronAPI.openTerminal(nodeId, cols, rows);
  }

  // terminal components filters for his terminal id
  output$(terminalId: string): Observable<string> {
    return this.outputSubject.asObservable().pipe(
      filter((o) => o.terminalId === terminalId),
      map((o) => o.data)
    );
  }

  closed$(terminalId: string): Observable<string> {
    return this.closedSubject.asObservable().pipe(
      filter((id) => id === terminalId)
    );
  }

  stopping$(terminalId: string): Observable<string> {
    return this.stoppingSubject.asObservable().pipe(
      filter((id) => id === terminalId)
    );
  }

  sendInput(terminalId: string, data: string): void {
    window.electronAPI.sendInput(terminalId, data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    window.electronAPI.resizeTerminal(terminalId, cols, rows);
  }

  close(terminalId: string): void {
    window.electronAPI.closeTerminal(terminalId);
  }

  ngOnDestroy(): void {
    this.outputSubject.complete();
    this.closedSubject.complete();
  }
}
