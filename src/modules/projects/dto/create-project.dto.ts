import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

// Wizard-shape request body. `draft` is a free-form JSON snapshot — the
// wizard owns its internal structure; we just persist it for dispatch
// to read back later.

/* Hard bounds on the persisted draft JSONB blob. The wizard owns its
 * internal shape (which is why we don't enumerate keys here), but
 * UNBOUNDED is unsafe: a hostile caller could POST megabytes of
 * arbitrary nested data straight into Postgres JSONB, which would
 * (a) inflate the row indefinitely, (b) slow every subsequent read,
 * and (c) potentially crash JSON deserialization on the dispatch
 * path. These caps are generous for the real wizard surface — a
 * typical campaign-creative draft is ~2-5KB; even a video-creative
 * draft with the heaviest brand-context blob and a long description
 * stays under ~15KB. 100KB leaves 6-10× headroom for future fields
 * and unicode-heavy Hebrew content without rejecting any plausible
 * real submission. */
const DRAFT_MAX_BYTES = 100 * 1024;
const DRAFT_MAX_DEPTH = 12;

function jsonDepth(value: unknown, seen: WeakSet<object> = new WeakSet()): number {
  if (value === null || typeof value !== 'object') return 0;
  if (seen.has(value as object)) return 0; // cycle guard — stringify below would also throw
  seen.add(value as object);
  let max = 0;
  if (Array.isArray(value)) {
    for (const item of value) {
      const d = jsonDepth(item, seen);
      if (d > max) max = d;
    }
  } else {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const d = jsonDepth((value as Record<string, unknown>)[key], seen);
      if (d > max) max = d;
    }
  }
  return max + 1;
}

@ValidatorConstraint({ name: 'BoundedJsonObject', async: false })
class BoundedJsonObjectConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      // Circular or non-serializable (BigInt, function, symbol) — reject.
      return false;
    }
    if (Buffer.byteLength(serialized, 'utf8') > DRAFT_MAX_BYTES) return false;
    if (jsonDepth(value) > DRAFT_MAX_DEPTH) return false;
    return true;
  }
  defaultMessage(_args: ValidationArguments): string {
    return `draft must be a plain JSON object, serialize to at most ${DRAFT_MAX_BYTES} bytes, and nest no deeper than ${DRAFT_MAX_DEPTH} levels`;
  }
}

export class CreateProjectDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  brandId!: string;

  @ApiProperty({
    description: 'Full wizard snapshot (must include `context` + `images[]`).',
    type: Object,
  })
  @IsObject()
  @Validate(BoundedJsonObjectConstraint)
  draft!: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Wizard ratio id: square | story | portrait. Required for image-output ' +
      'flows (campaign-creative); omitted for text-output flows like ' +
      'copywriting-ads. The dispatch services enforce per-flow requirements.',
    example: 'square',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  aspectRatio?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    default: 'campaign_creative',
    description: 'Reserved for future service types.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  serviceType?: string;
}
