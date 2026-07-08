import { TranslateService } from '@ngx-translate/core';

export interface ParsedAppError {
  code: string;
  params: Record<string, string>;
}

// The backend encodes structured errors as JSON in Error.message (see
// backend/models/app-error.ts) because that's the only thing Electron's IPC
// reliably carries across the renderer boundary. Anything that doesn't
// parse as { code, params } is a raw/unclassified error — shown as-is.
export function parseAppError(e: Error): ParsedAppError | null {
  try {
    const parsed = JSON.parse(e.message);
    if (parsed && typeof parsed.code === 'string') {
      return { code: parsed.code, params: parsed.params ?? {} };
    }
  } catch {
    /* not a structured AppError */
  }
  return null;
}

export function translateAppError(e: Error, translate: TranslateService): string {
  const parsed = parseAppError(e);
  return parsed ? translate.instant(`errors.${parsed.code}`, parsed.params) : e.message;
}
