import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import {ApiTags} from "@nestjs/swagger";
import {ApiDoc} from "./decorators/api-doc.decorator";

@ApiTags('info')
@Controller('/info')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @ApiDoc({
    summary: 'Get version of API',
    description: 'Version has returned',
    status: 200,
  })
  @Get()
  apiVersion(): string {
    return this.appService.apiVersion();
  }
}
