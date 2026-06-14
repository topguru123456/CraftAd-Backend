/** Shared generation failure mapping + logging helpers. */

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
    return 'עומס זמני בשרת ה-AI — נסו שוב בעוד דקה.';
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

  if (lower.includes('aspect ratio mismatch')) {
    return (
      'התמונה חזרה ביחס תצוגה שונה מהמבוקש (לרוב מרובע במקום סטורי). ' +
      'לחצו "יצירה נוספת" — המודל מייצר ביחס הנכון רוב הפעמים.'
    );
  }

  return raw;
}

export function formatGenerationFailureLog(context: {
  uid: string;
  kind: 'generate' | 'edit';
  raw: string;
  userMessage: string;
}): string {
  return [
    `uid=${context.uid}`,
    `kind=${context.kind}`,
    `raw=${JSON.stringify(context.raw)}`,
    `userMessage=${JSON.stringify(context.userMessage)}`,
  ].join(' ');
}
