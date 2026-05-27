export function ensureHttps(url: unknown): string {
  if (typeof url !== 'string' || !url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}
