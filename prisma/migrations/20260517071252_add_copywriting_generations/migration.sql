-- CreateTable
CREATE TABLE "copywriting_generations" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "GenerationStatus" NOT NULL DEFAULT 'pending',
    "ad_text" TEXT,
    "framework" TEXT,
    "framework_he" TEXT,
    "tones_used" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conversion_score" INTEGER,
    "bookmarked" BOOLEAN NOT NULL DEFAULT false,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "copywriting_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "copywriting_generations_project_id_idx" ON "copywriting_generations"("project_id");

-- CreateIndex
CREATE INDEX "copywriting_generations_user_id_idx" ON "copywriting_generations"("user_id");

-- CreateIndex
CREATE INDEX "copywriting_generations_status_idx" ON "copywriting_generations"("status");

-- AddForeignKey
ALTER TABLE "copywriting_generations" ADD CONSTRAINT "copywriting_generations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
