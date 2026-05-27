import {
  BadGatewayException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CopywritingGeneration } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { CopywritingPromptService } from './copywriting-prompt.service';
import { OpenAiCopywritingService } from './openai-copywriting.service';

// Read + mutation surface for existing copywriting variants. Same
// pattern as CreativeGenerationsService — every query scoped by userId
// from the JWT, "not yours" → 404.
//
// The dispatcher (CopywritingDispatchService) owns row creation; this
// service handles list / get / delete / bookmark-toggle / refine /
// updateAdText so the result page can render and the user can curate
// without re-running the full generation pipeline.

@Injectable()
export class CopywritingGenerationsService {
  private readonly logger = new Logger(CopywritingGenerationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly promptService: CopywritingPromptService,
    private readonly openai: OpenAiCopywritingService,
  ) {}

  listByProject(
    projectId: string,
    userId: string,
  ): Promise<CopywritingGeneration[]> {
    return this.prisma.copywritingGeneration.findMany({
      where: { projectId, userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async findOne(id: string, userId: string): Promise<CopywritingGeneration> {
    const row = await this.prisma.copywritingGeneration.findFirst({
      where: { id, userId },
    });
    if (!row) throw new NotFoundException('Generation not found');
    return row;
  }

  async remove(id: string, userId: string): Promise<{ id: string }> {
    const result = await this.prisma.copywritingGeneration.deleteMany({
      where: { id, userId },
    });
    if (result.count === 0) throw new NotFoundException('Generation not found');
    return { id };
  }

  // Bookmark toggle returns the new state so the FE can settle on the
  // server value (no client-side guess about the next state).
  async setBookmarked(
    id: string,
    userId: string,
    bookmarked: boolean,
  ): Promise<{ id: string; bookmarked: boolean }> {
    const result = await this.prisma.copywritingGeneration.updateMany({
      where: { id, userId },
      data: { bookmarked },
    });
    if (result.count === 0) throw new NotFoundException('Generation not found');
    return { id, bookmarked };
  }

  // AI refinement of an in-progress text. Does NOT touch the DB row —
  // the FE shows the refined text as a preview in the editor, and only
  // the explicit "save" path (updateAdText) persists. Keeping refine
  // stateless on the server means the user can chain multiple
  // refinements + undos without polluting the row's history with
  // never-saved intermediates.
  //
  // We still scope by id+userId before calling OpenAI — that prevents
  // a non-owner from burning the brand's OpenAI quota by hitting
  // /:other-user-id/refine with valid auth.
  async refineAdText(
    id: string,
    userId: string,
    currentText: string,
    instruction: string,
  ): Promise<{ refinedText: string }> {
    const row = await this.prisma.copywritingGeneration.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Generation not found');

    const { system, user } = this.promptService.buildRefinement(currentText, instruction);
    const result = await this.openai.refine(system, user);

    if (!result.ok) {
      this.logger.warn(`Refine ${id} failed: ${result.reason}`);
      throw new BadGatewayException('שיפור הטקסט נכשל — נסו שוב');
    }
    return { refinedText: result.refinedText };
  }

  // User-driven manual edit of the generated copy. Returns the full
  // row so the FE can settle on the canonical state (updatedAt moves
  // too — useful if we ever surface "last edited" on the card).
  //
  // Status is preserved at `ready` — a manual edit doesn't put the row
  // back into the AI pipeline, it's just text we trust the user owns
  // from this point. errorMessage is cleared in case the row was
  // previously failed and the user is hand-writing copy from scratch
  // (UI doesn't currently expose that path, but the cleanup is cheap
  // and prevents a stale error from haunting an edited row).
  async updateAdText(
    id: string,
    userId: string,
    adText: string,
  ): Promise<CopywritingGeneration> {
    const result = await this.prisma.copywritingGeneration.updateMany({
      where: { id, userId },
      data: {
        adText,
        status: 'ready',
        errorMessage: null,
      },
    });
    if (result.count === 0) throw new NotFoundException('Generation not found');
    return this.findOne(id, userId);
  }
}
