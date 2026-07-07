import { Component, Output, EventEmitter, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { Button } from 'primeng/button';
import { InputText } from 'primeng/inputtext';
import { TranslatePipe } from '@ngx-translate/core';
import { NetworkService } from '../../services/network.service';
import { LabLink } from '../../../../../backend/models/link.model';

@Component({
  selector: 'app-link-list',
  standalone: true,
  imports: [CommonModule, FormsModule, Button, InputText, TranslatePipe],
  styleUrl: './link-list.component.css',
  templateUrl: './link-list.component.html',
})
export class LinkListComponent {
  @Output() createLink = new EventEmitter<{ name: string; type: 'cable' | 'switch' }>();
  @Output() deleteLink = new EventEmitter<string>();

  private networkService = inject(NetworkService);
  links = toSignal(this.networkService.links$, { initialValue: [] as LabLink[] });

  showCreateInput = false;
  newLinkName = '';
  newLinkType: 'cable' | 'switch' = 'cable';

  toggleCreate(): void {
    this.showCreateInput = !this.showCreateInput;
    this.newLinkName = '';
    this.newLinkType = 'cable';
  }

  submitCreate(): void {
    const name = this.newLinkName.trim();
    if (!name) return;
    this.createLink.emit({ name, type: this.newLinkType });
    this.newLinkName = '';
    this.showCreateInput = false;
  }
}
