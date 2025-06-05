import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as rawBody from 'raw-body';

@Injectable()
export class RawBodyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RawBodyMiddleware.name);

  async use(req: Request, res: Response, next: NextFunction) {
    if (!req.readable) {
      return next();
    }

    try {
      const raw = await rawBody(req);
      const rawText = raw.toString().trim();
      req['rawBody'] = rawText;

      // Log the raw body for debugging
      this.logger.debug('Raw webhook body:', {
        length: rawText.length,
        preview: rawText.substring(0, 100) + '...'
      });

      // Re-create the body stream
      req.body = JSON.parse(rawText);
    } catch (error) {
      this.logger.error('Error processing raw body:', error);
    }

    next();
  }
}
