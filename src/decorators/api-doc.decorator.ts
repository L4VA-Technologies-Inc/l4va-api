import {applyDecorators, HttpStatus} from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';

interface ApiDocParams {
  summary: string,
  description: string,
  status: HttpStatus
}

export function ApiDoc({
                         summary,
                         description = '',
                         status = 200
}: ApiDocParams) {
  return applyDecorators(
    ApiOperation({ summary }),
    ApiResponse({ status, description })
  );
}
