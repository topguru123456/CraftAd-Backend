export type ReferenceAdSource = 'template' | 'upload';

/** Persisted on `projects.draft` by the campaign-creative wizard. */
export interface ReferenceAdDraft {
  url: string;
  path?: string;
  templateId?: string | null;
  source: ReferenceAdSource;
}

export function parseReferenceAd(draft: unknown): ReferenceAdDraft | null {
  if (!draft || typeof draft !== 'object') return null;
  const ref = (draft as { referenceAd?: unknown }).referenceAd;
  if (!ref || typeof ref !== 'object') return null;
  const url = (ref as ReferenceAdDraft).url;
  if (typeof url !== 'string' || !url.trim()) return null;
  const source = (ref as ReferenceAdDraft).source;
  return {
    url: url.trim(),
    path: typeof (ref as ReferenceAdDraft).path === 'string' ? (ref as ReferenceAdDraft).path : undefined,
    templateId:
      typeof (ref as ReferenceAdDraft).templateId === 'string'
        ? (ref as ReferenceAdDraft).templateId
        : null,
    source: source === 'upload' ? 'upload' : 'template',
  };
}

export function productImageUrlFromDraft(draft: unknown): string {
  const images = (draft as { images?: Array<{ url?: string }> })?.images;
  const url = images?.[0]?.url;
  return typeof url === 'string' ? url : '';
}
