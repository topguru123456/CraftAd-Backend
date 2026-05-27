-- CreateTable
CREATE TABLE "video_generations" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "GenerationStatus" NOT NULL DEFAULT 'pending',
    "mode" TEXT NOT NULL,
    "prompt" TEXT,
    "reference_image_url" TEXT,
    "aspect_ratio" TEXT NOT NULL,
    "duration_seconds" INTEGER NOT NULL DEFAULT 8,
    "video_url" TEXT,
    "poster_url" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_generations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_generations_project_id_idx" ON "video_generations"("project_id");

-- CreateIndex
CREATE INDEX "video_generations_user_id_idx" ON "video_generations"("user_id");

-- CreateIndex
CREATE INDEX "video_generations_status_idx" ON "video_generations"("status");

-- AddForeignKey
ALTER TABLE "video_generations" ADD CONSTRAINT "video_generations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
