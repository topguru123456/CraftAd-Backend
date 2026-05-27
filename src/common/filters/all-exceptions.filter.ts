import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Global exception filter — every uncaught error in the app lands here.
 *
 * Goals:
 *   - Consistent error shape on the wire: { error: { message, code? } }.
 *     One envelope the FE can rely on for every endpoint.
 *   - Never leak stack traces or internal messages on 500s. The client
 *     gets a generic message; the full error goes to server logs with
 *     a correlation hint (method + path) so we can find it later.
 *   - HttpException (NestJS's intentional throw) is honored — its
 *     status + response shape is preserved.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    /* HttpException = an intentional throw from one of our handlers
     * (e.g. throw new BadRequestException('uid required')). Preserve
     * its status and message exactly as the handler chose them. */
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : (body as { message?: string | string[] })?.message ??
            exception.message;
      response.status(status).json({
        error: {
          message: Array.isArray(message) ? message.join('; ') : message,
        },
      });
      return;
    }

    /* Anything else is an unexpected failure. Log everything we know;
     * tell the client only that something went wrong. */
    const status = HttpStatus.INTERNAL_SERVER_ERROR;
    this.logger.error(
      `Unhandled exception at ${request.method} ${request.originalUrl}`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    response.status(status).json({
      error: {
        message: 'Internal server error',
      },
    });
  }
}
