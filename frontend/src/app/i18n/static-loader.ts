import { TranslateLoader } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import { en } from './en';
import { it } from './it';

const TRANSLATIONS: Record<string, Record<string, string>> = { en, it };

export class StaticTranslateLoader implements TranslateLoader {
  getTranslation(lang: string): Observable<Record<string, string>> {
    return of(TRANSLATIONS[lang] ?? TRANSLATIONS['it']);
  }
}
