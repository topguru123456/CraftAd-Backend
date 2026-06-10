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

  // Primary read: the canonical `referenceAd` field. This is what the
  // campaign-creative wizard's reference-ad step writes today, and
  // what inspired-creation's fixed implementation writes.
  const ref = (draft as { referenceAd?: unknown }).referenceAd;
  if (ref && typeof ref === 'object') {
    const url = (ref as ReferenceAdDraft).url;
    if (typeof url === 'string' && url.trim()) {
      const source = (ref as ReferenceAdDraft).source;
      return {
        url: url.trim(),
        path:
          typeof (ref as ReferenceAdDraft).path === 'string'
            ? (ref as ReferenceAdDraft).path
            : undefined,
        templateId:
          typeof (ref as ReferenceAdDraft).templateId === 'string'
            ? (ref as ReferenceAdDraft).templateId
            : null,
        source: source === 'upload' ? 'upload' : 'template',
      };
    }
  }

  // Legacy-shape fallback: an earlier version of the inspired-creation
  // wizard wrote the inspo to `images[1]` instead of `referenceAd`
  // (because both fields are read by resolveCampaignGcfImageSlots and
  // the original implementation guessed the wrong one). Projects
  // created during that window still live in the DB with the old
  // shape; treating `images[1]` as the reference when no
  // `referenceAd` is set lets those rows recover on "Create more"
  // without a data migration. Safe for campaign-creative because that
  // wizard never populates `images[1]` (its product image goes in
  // `images[0]` and reference uploads always write `referenceAd`).
  const images = (draft as { images?: Array<{ url?: unknown; path?: unknown }> })
    .images;
  if (Array.isArray(images) && images.length >= 2) {
    const second = images[1];
    if (second && typeof second === 'object') {
      const url = second.url;
      if (typeof url === 'string' && url.trim()) {
        return {
          url: url.trim(),
          path: typeof second.path === 'string' ? second.path : undefined,
          templateId: null,
          source: 'upload',
        };
      }
    }
  }

  return null;
}

export function productImageUrlFromDraft(draft: unknown): string {
  const images = (draft as { images?: Array<{ url?: string }> })?.images;
  const url = images?.[0]?.url;
  return typeof url === 'string' ? url : '';
}
