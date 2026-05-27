-- CreateEnum
CREATE TYPE "BillingPaymentAttemptKind" AS ENUM ('verify', 'renewal', 'update_card');

-- CreateTable
CREATE TABLE "billing_payment_attempts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "BillingPaymentAttemptKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ILS',
    "period_end" TIMESTAMP(3),
    "tranzila_index" TEXT,
    "response_code" TEXT,
    "raw_response" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT false,
    "idempotency_key" TEXT NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_payment_attempts_idempotency_key_key" ON "billing_payment_attempts"("idempotency_key");

-- CreateIndex
CREATE INDEX "billing_payment_attempts_user_id_idx" ON "billing_payment_attempts"("user_id");

-- CreateIndex
CREATE INDEX "billing_payment_attempts_kind_created_at_idx" ON "billing_payment_attempts"("kind", "created_at");
