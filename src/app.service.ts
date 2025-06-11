import { Injectable } from '@nestjs/common';

import { version } from '../package.json';

@Injectable()
export class AppService {
  apiVersion(): string {
    return `L4va API version: ${version}`;
  }
}
