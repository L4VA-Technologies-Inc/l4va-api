import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { AppService } from './app.service';
import { ApiDoc } from './decorators/api-doc.decorator';

@ApiTags('info')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @ApiDoc({
    summary: 'Get version of API',
    description: 'Version has returned',
    status: 200,
  })
  @Get('info')
  apiVersion(): string {
    return this.appService.apiVersion();
  }

  @Get('health')
  healthCheck() {
    return { status: 'ok' };
  }
}
