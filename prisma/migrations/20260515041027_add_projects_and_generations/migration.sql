-- CreateEnum
CREATE TYPE "GenerationStatus" AS ENUM ('pending', 'dispatched', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "EditStatus" AS ENUM ('pending', 'dispatched', 'ready', 'failed');

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "brand_id" UUID NOT NULL,
    "service_type" TEXT NOT NULL DEFAULT 'campaign_creative',
    "name" TEXT,
    "draft" JSONB NOT NULL DEFAULT '{}',
    "aspect_ratio" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creative_generations" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "GenerationStatus" NOT NULL DEFAULT 'pending',
    "prompt" TEXT,
    "image_url" TEXT,
    "clean_image_url" TEXT,
    "error_message" TEXT,
    "creative_score" INTEGER,
    "performance_score" INTEGER,
    "recommendations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scored_at" TIMESTAMP(3),
    "edit_status" "EditStatus",
    "edit_image_url" TEXT,
    "edit_prompt" TEXT,
    "edit_error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creative_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "projects_user_id_idx" ON "projects"("user_id");

-- CreateIndex
CREATE INDEX "projects_brand_id_idx" ON "projects"("brand_id");

-- CreateIndex
CREATE INDEX "creative_generations_project_id_idx" ON "creative_generations"("project_id");

-- CreateIndex
CREATE INDEX "creative_generations_user_id_idx" ON "creative_generations"("user_id");

-- CreateIndex
CREATE INDEX "creative_generations_status_idx" ON "creative_generations"("status");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_generations" ADD CONSTRAINT "creative_generations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
