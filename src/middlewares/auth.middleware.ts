import { Injectable, NestMiddleware, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  private readonly validApiKey = process.env.X_API_KEY;

  use(req: Request, res: Response, next: NextFunction) {
    const apiKey = req.headers['x-api-key'] as string;
    if (!apiKey) {
      throw new UnauthorizedException('API key is missing');
    }

    if (apiKey !== this.validApiKey) {
      throw new ForbiddenException('Invalid API key');
    }

    next();
  }
}
