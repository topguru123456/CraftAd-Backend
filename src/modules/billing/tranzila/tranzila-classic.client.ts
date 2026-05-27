import { BadGatewayException, Injectable, Logger } from '@nestjs/common';

/* Tranzila classic wire client.
 *
 * Pure HTTP — no DB, no Supabase, no business logic. Two operations:
 *
 *   createHandshake({ supplier, sum, pw })
 *     GET api.tranzila.com/v1/handshake/create
 *     Returns the `thtk` token the iframe needs to prove the session
 *     was initiated by us. Server-side only because TranzilaPW is in
 *     the query string.
 *
 *   chargeWithToken({ supplier, token, sum, ... })
 *     POST secure5.tranzila.com/cgi-bin/tranzila31tk.cgi
 *     Server-side token charge using a previously-stored TranzilaTK.
 *     Used by the renewal runner.
 *
 * Both methods accept credentials per-call (supplier + pw). The Craftad
 * deployment has TWO terminals — fxpdply123 for iframe + fxpdply123tok
 * for server-side renewals — and they have different passwords, so the
 * client cannot hardcode one set. The service layer above resolves the
 * right pair from env per operation.
 *
 * Wire contract is from docs/billing-tranzila.md §4. Update both in
 * lockstep when Tranzila changes anything.
 */

/* Endpoints. Constants rather than env because they're stable Tranzila
 * infrastructure URLs that change roughly never; making them configurable
 * just invites a deployment-time bug. */
const HANDSHAKE_URL = 'https://api.tranzila.com/v1/handshake/create';
const TOKEN_CHARGE_URL = 'https://secure5.tranzila.com/cgi-bin/tranzila31tk.cgi';
const IFRAME_HOST = 'https://directng.tranzila.com';

/* 15s matches GcfImagePrepService + dispatch services in this codebase.
 * Tranzila's handshake responds in <500ms; token charge in 2-5s including
 * acquirer roundtrip. 15s leaves headroom without letting a hung connection
 * tie up the runner forever. */
const REQUEST_TIMEOUT_MS = 15_000;

export interface TranzilaHandshakeRequest {
  /** Terminal name, e.g. "fxpdply123". */
  supplier: string;
  /** Major units (decimal shekels). For trial verify: 1. */
  sum: number;
  /** TranzilaPW for this terminal. */
  pw: string;
}

export type TranzilaChargeMode =
  /** Standard debit charge. Used for renewals. */
  | 'A'
  /** Credit / refund — requires original `index` (out of v1 scope, exposed for completeness). */
  | 'C';

export interface TranzilaChargeRequest {
  /** Terminal name, e.g. "fxpdply123tok". */
  supplier: string;
  /** TranzilaPW for this terminal. */
  pw: string;
  /** Previously-stored TranzilaTK from a successful tokenize. */
  token: string;
  /** Major units (decimal shekels). Caller converts from internal agorot. */
  sum: number;
  /** ISO-numeric currency code. 1 = ILS. Always 1 in our deployment today. */
  currency: number;
  /** Card expiration in MMYY (4 digits). Derived from stored expmonth+expyear. */
  expdate: string;
  /** Transaction mode. 'A' for renewals; 'C' for refunds. */
  tranmode: TranzilaChargeMode;
  /** Credit type. 1 = regular (default). 6/8 for installments — not used today. */
  credType?: number;
  /** Israeli ID — required by some issuers when Response=057 surfaces. */
  myid?: string;
  /** Original transaction `index` — REQUIRED when tranmode='C' (refund). */
  index?: string;
}

/* Parsed Tranzila response. `raw` is preserved verbatim for audit logging
 * (billing_payment_attempts.raw_response). `fields` is the full key→value
 * map so callers can read any field we didn't promote to a typed property. */
export interface TranzilaResponseFields {
  /** 3-digit response code. '000' = success. Empty string if Tranzila returned no Response field. */
  responseCode: string;
  /** Authorization number from the card network, on success. */
  confirmationCode?: string;
  /** Tranzila's transaction id. Required for any later credit/refund. */
  index?: string;
  /** TranzilaTK echoed back (token-charge endpoint echoes it on success). */
  token?: string;
  /** Card expiry month (2 digits). */
  expmonth?: string;
  /** Card expiry year (2 digits, YY). */
  expyear?: string;
  /** Masked PAN (last 4 visible). Do not store as-is. */
  ccno?: string;
  /** Echoed sum (decimal shekels). */
  sum?: string;
  /** Original response body verbatim. */
  raw: string;
  /** Full parsed field map for any property not promoted above. */
  fields: Record<string, string>;
}

@Injectable()
export class TranzilaClassicClient {
  private readonly logger = new Logger(TranzilaClassicClient.name);

  /* Mint a handshake token (thtk) for an iframe session.
   *
   * Tranzila returns plain text. Some terminals respond with `thtk=<token>`,
   * others with just `<token>`; we strip the prefix if present. The token is
   * single-use and time-bounded — call this immediately before handing the
   * iframe URL to the FE, not at startup. */
  async createHandshake(input: TranzilaHandshakeRequest): Promise<string> {
    const url = new URL(HANDSHAKE_URL);
    url.searchParams.set('supplier', input.supplier);
    url.searchParams.set('sum', formatSum(input.sum));
    url.searchParams.set('TranzilaPW', input.pw);

    const body = await this.execHttp({
      url: url.toString(),
      method: 'GET',
      action: 'handshake',
      supplier: input.supplier,
    });

    const trimmed = body.trim();
    const token = trimmed.startsWith('thtk=') ? trimmed.slice(5) : trimmed;
    if (!token) {
      throw new BadGatewayException('Tranzila handshake returned an empty token');
    }
    this.logger.log(
      `handshake ok supplier=${input.supplier} sum=${input.sum} thtk=${token.slice(0, 6)}...`,
    );
    return token;
  }

  /* Server-side token charge against the token terminal.
   *
   * Caller decides what to do with the result — we just parse and return.
   * The renewal runner (and refund flow) branches on `responseCode` and
   * writes the audit row. Never auto-retry from this client; retries belong
   * at the service layer where idempotency is enforced. */
  async chargeWithToken(input: TranzilaChargeRequest): Promise<TranzilaResponseFields> {
    if (input.tranmode === 'C' && !input.index) {
      throw new Error('Tranzila refund (tranmode=C) requires the original index');
    }

    const params = new URLSearchParams();
    params.set('supplier', input.supplier);
    params.set('TranzilaPW', input.pw);
    params.set('TranzilaTK', input.token);
    params.set('sum', formatSum(input.sum));
    params.set('currency', String(input.currency));
    params.set('expdate', input.expdate);
    params.set('tranmode', input.tranmode);
    params.set('cred_type', String(input.credType ?? 1));
    if (input.myid) params.set('myid', input.myid);
    if (input.index) params.set('index', input.index);

    const body = await this.execHttp({
      url: TOKEN_CHARGE_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      action: 'token-charge',
      supplier: input.supplier,
    });

    const parsed = parseClassicResponse(body);
    this.logger.log(
      `token-charge supplier=${input.supplier} sum=${input.sum} ` +
        `response=${parsed.responseCode || '<empty>'} ` +
        `index=${parsed.index ?? '-'} conf=${parsed.confirmationCode ?? '-'}`,
    );
    return parsed;
  }

  /* Compose the iframe URL the FE embeds. The actual params (thtk, sum,
   * tranmode, etc.) go in either the query string or as form fields when
   * the iframe is POST-rendered; this helper just returns the base URL
   * for the supplier, since the caller assembles params from context. */
  buildIframeUrl(supplier: string): string {
    return `${IFRAME_HOST}/${encodeURIComponent(supplier)}/iframenew.php`;
  }

  /* Shared HTTP path. Timeout + AbortController mirror the existing
   * dispatch services. BadGatewayException on transport failure so the
   * filter renders a 502 rather than a 500 — this is the right semantic
   * since we're failing because of an upstream third-party.
   *
   * Tranzila's response bodies are urlencoded text on the token charge
   * and plain text on the handshake; both come back via response.text(). */
  private async execHttp(options: {
    url: string;
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    action: string;
    supplier: string;
  }): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(options.url, {
        method: options.method,
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        this.logger.warn(
          `tranzila ${options.action} HTTP ${response.status} supplier=${options.supplier} ` +
            `body=${truncate(text, 200)}`,
        );
        throw new BadGatewayException(
          `Tranzila ${options.action} returned HTTP ${response.status}`,
        );
      }

      return text;
    } catch (err) {
      if (err instanceof BadGatewayException) throw err;
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const detail = isAbort
        ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : err instanceof Error
          ? err.message
          : String(err);
      this.logger.error(
        `tranzila ${options.action} transport failure supplier=${options.supplier} ${detail}`,
      );
      throw new BadGatewayException(`Tranzila ${options.action} failed: ${detail}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

/* Parse Tranzila's urlencoded response into a typed object.
 *
 * Defensive — Tranzila's classic CGI is decades old and emits subtly
 * different bodies across endpoints:
 *   - trailing CRLF or none
 *   - keys without values (`Response=`)
 *   - values with `=` inside (split on FIRST `=` only)
 *   - URL-encoded bytes (`%20`) and `+` for space
 *   - duplicate keys (last one wins)
 *
 * Never throws on malformed input — returns an empty `responseCode` so
 * callers can branch on that as "unparseable response, treat as failure."
 *
 * Exported as a standalone function so unit tests can hit it without
 * spinning up the Nest container. */
export function parseClassicResponse(raw: string): TranzilaResponseFields {
  const fields: Record<string, string> = {};
  const trimmed = raw.trim();

  if (trimmed) {
    for (const pair of trimmed.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq === -1) {
        fields[pair] = '';
        continue;
      }
      const key = pair.slice(0, eq);
      const rawValue = pair.slice(eq + 1).replace(/\+/g, ' ');
      try {
        fields[key] = decodeURIComponent(rawValue);
      } catch {
        /* malformed percent-encoding — keep the raw value rather than throw */
        fields[key] = rawValue;
      }
    }
  }

  return {
    responseCode: fields.Response ?? '',
    confirmationCode: fields.ConfirmationCode || undefined,
    index: fields.index || undefined,
    token: fields.TranzilaTK || undefined,
    expmonth: fields.expmonth || undefined,
    expyear: fields.expyear || undefined,
    ccno: fields.ccno || undefined,
    sum: fields.sum || undefined,
    raw,
    fields,
  };
}

/* Categorize a Response code so the service layer doesn't repeat the
 * branching logic. Source: docs/billing-tranzila.md §6.
 *
 *   success    → '000' only
 *   terminal   → don't retry; flip subscription to past_due, surface
 *                update-card UX. Card-side or auth-side failure.
 *   transient  → Tranzila-side or network-flavor failure; safe to retry
 *                on next runner sweep. Period_end is NOT advanced.
 *   unknown    → treat as terminal for safety; alert. */
export type TranzilaResponseClass = 'success' | 'terminal' | 'transient' | 'unknown';

const TERMINAL_CODES = new Set([
  '001', '002', '003', '004', '005', '006', '014', '017',
  '033', '034', '035', '036', '037', '038', '039',
  '044', '045', '057', '058',
  '062', '063', '064', '065',
  '101', '107',
  '900', '903',
]);

const TRANSIENT_CODES = new Set([
  '099', '200', '951', '952', '954', '955', '959',
]);

export function classifyResponseCode(code: string): TranzilaResponseClass {
  if (code === '000') return 'success';
  if (TERMINAL_CODES.has(code)) return 'terminal';
  if (TRANSIENT_CODES.has(code)) return 'transient';
  /* 116-129 (terminal-not-authorized) + 130-180 (card-program restrictions)
   * are documented as terminal in §6. Match by numeric range so we don't
   * have to enumerate every one. */
  const n = Number.parseInt(code, 10);
  if (Number.isFinite(n) && ((n >= 116 && n <= 129) || (n >= 130 && n <= 180))) {
    return 'terminal';
  }
  return 'unknown';
}

/* Format a numeric amount as Tranzila expects in `sum`: decimal shekels
 * with up to 2 decimal places, no trailing zeros required. 129 → "129",
 * 62.5 → "62.50", 1 → "1". Use toFixed(2) for predictability since
 * Tranzila's parser is lenient but the FE-visible amount in §3 of the
 * doc is rendered with cents. */
function formatSum(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid Tranzila sum: ${value}`);
  }
  /* Use toFixed(2) so a whole number like 129 becomes "129.00" — keeps
   * the wire format consistent and matches what Tranzila echoes back. */
  return value.toFixed(2);
}

function truncate(value: string, n: number): string {
  return value.length <= n ? value : `${value.slice(0, n)}…`;
}
