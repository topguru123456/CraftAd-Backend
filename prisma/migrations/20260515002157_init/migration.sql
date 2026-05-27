-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "slogan" TEXT NOT NULL DEFAULT '',
    "logo_url" TEXT,
    "logos" JSONB NOT NULL DEFAULT '[]',
    "colors" JSONB NOT NULL DEFAULT '[]',
    "values" JSONB NOT NULL DEFAULT '[]',
    "tone" TEXT,
    "website_url" TEXT NOT NULL DEFAULT '',
    "domain" TEXT,
    "socials" JSONB NOT NULL DEFAULT '[]',
    "industries" JSONB NOT NULL DEFAULT '[]',
    "primary_language" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "brands_user_id_idx" ON "brands"("user_id");
