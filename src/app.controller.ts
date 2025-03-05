import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller('/info')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  apiVersion(): string {
    return this.appService.apiVersion();
  }
}
