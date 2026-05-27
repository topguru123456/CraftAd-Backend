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
