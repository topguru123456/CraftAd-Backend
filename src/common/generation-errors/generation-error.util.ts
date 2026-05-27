/** Shared generation failure mapping, logging helpers, and retry detection. */

export const GCF_RATE_LIMIT_MAX_RETRIES = 3;

const RATE_LIMIT_DELAYS_MS = [2000, 5000, 10000];

export function rateLimitRetryDelayMs(attempt: number): number {
  return RATE_LIMIT_DELAYS_MS[Math.min(attempt - 1, RATE_LIMIT_DELAYS_MS.length - 1)] ?? 10000;
}

export function isRetryableRateLimitError(raw: string): boolean {
  const lower = raw.toLowerCase();
  return (
    lower.includes('resource_exhausted') ||
    lower.includes('429') ||
    /\b429\b/.test(raw) ||
    lower.includes('quota') && lower.includes('exhausted')
  );
}

export function mapGenerationErrorForUser(raw: string): string {
  const lower = raw.toLowerCase();

  if (isRetryableRateLimitError(raw)) {
    return (
      'עומס זמני בשרת Gemini (מכסה / 429). המערכת מנסה שוב אוטומטית — ' +
      'אם הבקשה עדיין נכשלת, המתינו דקה ולחצו "יצירה נוספת".'
    );
  }

  if (
    lower.includes('no image content') ||
    lower.includes('returned no image') ||
    lower.includes('no portrait image')
  ) {
    return (
      'מודל Gemini לא החזיר תמונה — לרוב בגלל מגבלות בטיחות (דמויות מוגנות, ' +
      'שמות מותגים/סרטים, תוכן מיני וכו׳). נסו תיאור מקורי ללא דמויות מוגנות, ' +
      'או שנו את הסצנה והפעילו שוב.'
    );
  }

  if (lower.includes('image_safety') || lower.includes('safety filter')) {
    return (
      'הבקשה נחסמה על ידי מסנן הבטיחות של Gemini. שנו את התיאור או את ' +
      'תמונת המוצר והפעילו שוב.'
    );
  }

  if (lower.includes('invalid_argument') || lower.includes('invalid argument')) {
    return (
      'בקשה לא תקינה לשרת היצירה — בדקו שתמונת המוצר והלוגו נטענו ' +
      'בהצלחה ונסו שוב.'
    );
  }

  return raw;
}

export function formatGenerationFailureLog(context: {
  uid: string;
  kind: 'generate' | 'edit';
  raw: string;
  userMessage: string;
  retrying?: boolean;
  attempt?: number;
  maxAttempts?: number;
}): string {
  const parts = [
    `uid=${context.uid}`,
    `kind=${context.kind}`,
    `raw=${JSON.stringify(context.raw)}`,
    `userMessage=${JSON.stringify(context.userMessage)}`,
  ];
  if (context.retrying) {
    parts.push(`retrying=true`, `attempt=${context.attempt}/${context.maxAttempts}`);
  }
  return parts.join(' ');
}
