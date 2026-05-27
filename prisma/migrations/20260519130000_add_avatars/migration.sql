-- CreateTable
CREATE TABLE "avatars" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "brand_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT,
    "gender" TEXT,
    "age_min" INTEGER,
    "age_max" INTEGER,
    "target_audience" TEXT,
    "language" TEXT NOT NULL DEFAULT 'he',
    "interests" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dreams_goals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "more_details" TEXT,
    "portrait_url" TEXT,
    "thumbnail_url" TEXT,
    "ai_blob" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "avatars_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "avatars_brand_id_idx" ON "avatars"("brand_id");
CREATE INDEX "avatars_user_id_idx" ON "avatars"("user_id");

-- AddForeignKey
ALTER TABLE "avatars" ADD CONSTRAINT "avatars_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;
