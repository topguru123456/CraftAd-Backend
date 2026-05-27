import { parseReferenceAd, productImageUrlFromDraft } from './campaign-draft';
import { ensureHttps } from './gcf-url';

export type CampaignReferenceMode = 'user' | 'fallback';

export interface CampaignGcfImageSlots {
  logo: string;
  product: string;
  example: string;
  font: string;
  referenceMode: CampaignReferenceMode;
}

/** Resolves the four GCF image URLs for campaign-creative dispatch.
 *  User reference ad is optional (Bubble parity). GCF still needs a
 *  fetchable `example` URL — when omitted we duplicate `logo` for that
 *  slot only; the prompt tells Gemini not to treat it as a layout blueprint.
 *  `example` must never reuse `product`. */
export function resolveCampaignGcfImageSlots(input: {
  logoUrl: string;
  draft: unknown;
  fontReferenceUrl: string;
}): CampaignGcfImageSlots {
  const product = ensureHttps(productImageUrlFromDraft(input.draft));
  const logo = ensureHttps(input.logoUrl);
  const font = ensureHttps(input.fontReferenceUrl);

  const userRef = parseReferenceAd(input.draft);
  if (userRef?.url) {
    const example = ensureHttps(userRef.url);
    return {
      logo,
      product,
      example,
      font,
      referenceMode: 'user',
    };
  }

  const pipelineExample = logo;
  return {
    logo,
    product,
    example: pipelineExample,
    font,
    referenceMode: 'fallback',
  };
}
