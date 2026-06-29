import { z } from 'zod';

// Adding a new env var? Add it here, then read it via AppConfigService.
// Never read process.env directly elsewhere.

// dotenv sets blank `KEY=` lines to "", which fails .min(1). Map "" → undefined
// so optional fields accept blanks and required ones report "Required".
const emptyAsUndefined = (schema: z.ZodTypeAny) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

export const envSchema = z.object({
  // Runtime
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'verbose'])
    .default('info'),

  // Supabase. JWT verification uses the project's JWKS endpoint
  // (URL derived from SUPABASE_URL), not the legacy HS256 secret.
  // JWT_SECRET kept optional in case we add HS256 fallback later.
  SUPABASE_URL: emptyAsUndefined(z.string().url()),
  SUPABASE_SERVICE_ROLE_KEY: emptyAsUndefined(z.string().min(1)),
  SUPABASE_JWT_SECRET: emptyAsUndefined(z.string().min(1).optional()),

  // DATABASE_URL = pooled (port 6543) for runtime.
  // DIRECT_URL  = direct (port 5432) for migrations.
  DATABASE_URL: emptyAsUndefined(z.string().url()),
  DIRECT_URL: emptyAsUndefined(z.string().url()),

  // AI providers / external APIs — optional at schema level; consumers throw if absent.
  OPENAI_API_KEY: emptyAsUndefined(z.string().min(1).optional()),
  GEMINI_API_KEY: emptyAsUndefined(z.string().min(1).optional()),
  CONTEXT_DEV_API_KEY: emptyAsUndefined(z.string().min(1).optional()),
  PEXELS_API_KEY: emptyAsUndefined(z.string().min(1).optional()),

  // Public URL of THIS backend, used as the webhook_url we hand to the GCF
  // dispatcher. Dev: an ngrok URL. Prod: the Cloud Run URL.
  BACKEND_PUBLIC_URL: emptyAsUndefined(z.string().url().optional()),
  API_SECRET: emptyAsUndefined(z.string().min(1).optional()),
  GENERATE_DISPATCHER_URL: emptyAsUndefined(
    z
      .string()
      .url()
      .default('https://generate-image-dispatcher-913804248295.us-central1.run.app'),
  ),
  EDIT_DISPATCHER_URL: emptyAsUndefined(
    z
      .string()
      .url()
      .default('https://edit-image-dispatch-913804248295.us-central1.run.app'),
  ),
  // Typography specimen URL for GCF `images.font` (campaign + product images).
  FONT_REFERENCE_URL: emptyAsUndefined(z.string().url().optional()),
  WEBHOOK_SECRET: emptyAsUndefined(z.string().min(1).optional()),

  // CORS — comma-separated allowlist. No '*' since we send credentials.
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((s) => s.split(',').map((o) => o.trim()).filter(Boolean)),

  // ── Stripe billing ────────────────────────────────────────────────
  //
  // STRIPE_SECRET_KEY        sk_test_... / sk_live_... — backend-side key
  //                          used by /billing/checkout + /billing/portal.
  // STRIPE_WEBHOOK_SECRET    whsec_... — for verifying Stripe signature on
  //                          POST /billing/webhook. From Stripe Dashboard →
  //                          Developers → Webhooks → (endpoint) → Signing
  //                          secret. Different per env (test/live).
  // STRIPE_PRICE_*           Stripe Price IDs. The "_MONTHLY" variants are
  //                          optional — set them only when monthly Prices
  //                          exist in your Stripe product. Plain (no suffix)
  //                          = the YEARLY price, which is what's currently
  //                          configured (see VITE_STRIPE_PRICE_* in the
  //                          project-root .env).
  // APP_PUBLIC_URL           Where the user's BROWSER reaches the FE
  //                          (http://localhost:3000 dev, https://app.craftad.io
  //                          prod). Used for Stripe Checkout/Portal
  //                          success/cancel redirects — distinct from
  //                          BACKEND_PUBLIC_URL above (which is the API).
  STRIPE_SECRET_KEY:      emptyAsUndefined(z.string().min(1).optional()),
  STRIPE_WEBHOOK_SECRET:  emptyAsUndefined(z.string().min(1).optional()),
  STRIPE_PRICE_STARTER:   emptyAsUndefined(z.string().min(1).optional()),
  STRIPE_PRICE_SCALE:     emptyAsUndefined(z.string().min(1).optional()),
  STRIPE_PRICE_PRO:       emptyAsUndefined(z.string().min(1).optional()),
  STRIPE_PRICE_STARTER_MONTHLY: emptyAsUndefined(z.string().min(1).optional()),
  STRIPE_PRICE_SCALE_MONTHLY:   emptyAsUndefined(z.string().min(1).optional()),
  STRIPE_PRICE_PRO_MONTHLY:     emptyAsUndefined(z.string().min(1).optional()),
  APP_PUBLIC_URL: emptyAsUndefined(z.string().url().optional()),

  // ── Tranzila billing (classic iframe + token renewals) ────────────
  //
  // BILLING_PROVIDER         Routes /billing/* through Stripe or Tranzila.
  //                          Defaults to 'stripe' so existing deployments
  //                          keep working; flip to 'tranzila' at cutover.
  // TRANZILA_TERMINAL_CHARGE Iframe-facing terminal (handles card capture
  //                          + Apple Pay + Google Pay). e.g. 'fxpdply123'.
  // TRANZILA_TERMINAL_TOKEN  Server-side token-charge terminal used by the
  //                          renewal runner via tranzila31tk.cgi.
  //                          e.g. 'fxpdply123tok'.
  // TRANZILA_PW_CHARGE       TranzilaPW for the charge terminal. Server-
  //                          only; never sent to the FE.
  // TRANZILA_PW_TOKEN        TranzilaPW for the token terminal. Server-
  //                          only; never sent to the FE.
  // TRANZILA_ADMIN_SECRET    Bearer token required on
  //                          POST /billing/tranzila/run-renewals. Phase 1
  //                          uses this for manual curl triggers; Phase 5
  //                          Cloud Scheduler uses the same value.
  //
  // All Tranzila vars are optional at the schema level so the API still
  // boots with provider=stripe. Tranzila services throw at instantiation
  // when provider=tranzila and a required value is missing — same pattern
  // as the Stripe keys above.
  BILLING_PROVIDER:         z.enum(['stripe', 'tranzila']).default('stripe'),
  TRANZILA_TERMINAL_CHARGE: emptyAsUndefined(z.string().min(1).optional()),
  TRANZILA_TERMINAL_TOKEN:  emptyAsUndefined(z.string().min(1).optional()),
  TRANZILA_PW_CHARGE:       emptyAsUndefined(z.string().min(1).optional()),
  TRANZILA_PW_TOKEN:        emptyAsUndefined(z.string().min(1).optional()),
  TRANZILA_ADMIN_SECRET:    emptyAsUndefined(z.string().min(16).optional()),

  // ── DEV BYPASS — REMOVE BEFORE PROD ──────────────────────────────
  //
  // TRANZILA_BYPASS_ENABLED  Temporary flag that turns on
  //                          POST /billing/tranzila/bypass-trial. When
  //                          true, an authenticated user can short-
  //                          circuit the Tranzila iframe and land in the
  //                          app as a "trialing" user without going
  //                          through real card capture. Useful while
  //                          we coordinate real test cards with the
  //                          merchant team. Default false; production
  //                          deploys MUST NOT set this.
  //
  // Pair with frontend env VITE_TRANZILA_BYPASS_ENABLED to expose the
  // bypass button in the trial page UI. The BE flag is the actual
  // gate — without it the endpoint returns 403 even if the FE shows
  // the button.
  TRANZILA_BYPASS_ENABLED: z.preprocess(
    (v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' || v === undefined || v === '' ? false : v),
    z.boolean().default(false),
  ),

  // ── PAYMENT TEST MODE — REMOVE BEFORE PROD ───────────────────────
  //
  // BILLING_TEST_MODE   When true, EVERY plan-renewal charge is sent
  //                     to Tranzila as ₪1 regardless of the actual
  //                     plan price. Used for verifying the full
  //                     payment pipeline (signup → trial → renewal →
  //                     plan switch → cancel) with real Tranzila
  //                     transactions but at a token cost. Trial J5
  //                     verify is ALREADY ₪1 by Tranzila convention,
  //                     so it's unaffected. Pair with frontend env
  //                     VITE_BILLING_TEST_MODE to show ₪1 prices in
  //                     the FE + a TEST MODE banner.
  //
  // Production deploys MUST set this to false. The boot logger emits
  // a WARN line when it's on so a misconfigured deploy is loud.
  BILLING_TEST_MODE: z.preprocess(
    (v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' || v === undefined || v === '' ? false : v),
    z.boolean().default(false),
  ),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse process.env once at boot. Throws a formatted error listing
 * every offending key so we don't get a confusing "X is undefined"
 * at runtime three layers deep in some handler.
 */
export function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Environment validation failed:\n${issues}\n\n` +
        `Check backend/.env against backend/.env.example.`,
    );
  }
  return parsed.data;
}
