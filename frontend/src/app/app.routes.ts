import { Routes } from '@angular/router';
import { MainLayoutComponent } from './components/main-layout/main-layout.component';
import { TerminalPageComponent } from './components/terminal-page/terminal-page.component';

export const routes: Routes = [
  { path: '', component: MainLayoutComponent },
  { path: 'terminal', component: TerminalPageComponent },
  { path: '**', redirectTo: '' },
];
