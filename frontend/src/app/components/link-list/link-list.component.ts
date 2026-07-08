import { Component, Output, EventEmitter, inject, ElementRef, ViewChild, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { Button } from 'primeng/button';
import { InputText } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';
import { MessageService, ConfirmationService } from 'primeng/api';
import { TranslateService, TranslatePipe } from '@ngx-translate/core';
import { NetworkService } from '../../services/network.service';
import { LabLink } from '../../../../../backend/models/link.model';

@Component({
  selector: 'app-link-list',
  standalone: true,
  imports: [CommonModule, FormsModule, Button, InputText, TooltipModule, TranslatePipe],
  styleUrl: './link-list.component.css',
  templateUrl: './link-list.component.html',
})
export class LinkListComponent {
  @Output() deleteLink = new EventEmitter<string>();

  private networkService      = inject(NetworkService);
  private messageService      = inject(MessageService);
  private confirmationService = inject(ConfirmationService);
  private translate           = inject(TranslateService);

  links = toSignal(this.networkService.links$, { initialValue: [] as LabLink[] });

  @ViewChild('createRow') createRowRef?: ElementRef<HTMLElement>;

  showCreateInput = false;
  newLinkName = '';
  nameError      = false;
  nameErrorShake = false;

  // Click-outside instead of (blur): blur fires on mousedown, before the
  // confirm button's own click handler runs, which would close (and wipe)
  // the row before submitCreate() even gets to show the duplicate-name
  // error. A document-level click always fires after the target's own
  // handler, so by the time we check, submitCreate() has already run.
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.showCreateInput) return;
    if (this.createRowRef && !this.createRowRef.nativeElement.contains(event.target as Node)) {
      this.showCreateInput = false;
      this.newLinkName = '';
      this.nameError = false;
      this.nameErrorShake = false;
    }
  }

  toggleCreate(): void {
    this.showCreateInput = !this.showCreateInput;
    this.newLinkName = '';
    this.nameError = false;
    this.nameErrorShake = false;
  }

  submitCreate(): void {
    const name = this.newLinkName.trim();
    if (!name) return;

    if (this.links().some(l => l.name === name)) {
      this.triggerNameError();
      return;
    }

    this.networkService.createLink(name).subscribe({
      next: () => {
        this.messageService.add({
          severity: 'success',
          summary: `Link "${name}"${this.translate.instant('links.created-suffix')}`,
          life: 3000,
        });
        this.newLinkName = '';
        this.showCreateInput = false;
      },
      error: (e: Error) => {
        // Race tra due finestre: il check sopra non l'ha visto, ma il
        // backend rifiuta comunque — stesso trattamento inline, non il
        // modale generico.
        if (e.message.includes('già esistente')) {
          this.triggerNameError();
          return;
        }
        this.showError(e);
      },
    });
  }

  private triggerNameError(): void {
    this.nameError = true;
    this.nameErrorShake = false;
    setTimeout(() => {
      this.nameErrorShake = true;
      setTimeout(() => { this.nameErrorShake = false; }, 500);
    });
  }

  private showError(e: Error): void {
    this.confirmationService.confirm({
      message: e.message,
      header: this.translate.instant('error.title'),
      icon: 'pi pi-exclamation-triangle',
      acceptLabel: this.translate.instant('btn.ok'),
      rejectVisible: false,
      acceptButtonProps: { severity: 'danger' },
      accept: () => {},
    });
  }
}
