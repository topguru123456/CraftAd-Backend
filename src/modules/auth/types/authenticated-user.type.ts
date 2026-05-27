// Shape of request.user after JwtAuthGuard runs.
// id == Supabase auth.users.id. metadata == auth.users.raw_user_meta_data.
// app_metadata holds provider info (Google, etc.).

export interface AuthenticatedUser {
  id: string;
  email?: string;
  metadata: UserMetadata;
  appMetadata: AppMetadata;
}

// User-writable. Keys match what the FE persists, mostly snake_case from
// the Google OAuth payload plus our own (onboarding, stripe_customer_id,
// subscription_*). Index signature keeps unknown keys typesafe to read.
//
// subscription_* keys are written EXCLUSIVELY by BillingWebhookService
// after Stripe events. The QuotaService + PlanLimitGuard read them to
// resolve the user's current plan. Never write to them from anywhere
// else — that's what creates the "FE shows wrong plan after subscribe"
// class of bugs.
export interface UserMetadata {
  name?: string;
  full_name?: string;
  picture?: string;
  avatar_url?: string;
  email_verified?: boolean;
  phone_verified?: boolean;
  onboarding?: Onboarding;
  stripe_customer_id?: string;
  subscription_plan_id?: string | null;
  subscription_cycle?: 'monthly' | 'yearly' | null;
  subscription_status?: string | null;
  subscription_id?: string | null;
  subscription_current_period_end?: number | null;
  [key: string]: unknown;
}

export interface Onboarding {
  step?: number;
  completed?: boolean;
  completedAt?: string;
  answers?: {
    role?: string;
    reason?: string;
    source?: string;
    teamSize?: string;
    activityType?: string;
    [key: string]: unknown;
  };
}

// Set by Supabase / our backend (not user-writable from the client).
export interface AppMetadata {
  provider?: string;
  providers?: string[];
  [key: string]: unknown;
}
