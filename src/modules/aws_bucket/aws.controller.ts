import {
  BadRequestException,
  ClassSerializerInterceptor,
  Controller,
  Get,
  Logger,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { Express, Response, Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';

import { AwsService } from './aws.service';

import { FileEntity } from '@/database/file.entity';
import { ApiDoc } from '@/decorators/api-doc.decorator';

export const mbMultiplication = 1024 * 1024;

@ApiTags('files')
@Controller('')
@UseInterceptors(ClassSerializerInterceptor)
export class AwsController {
  private readonly logger = new Logger(AwsController.name);
  constructor(private readonly awsService: AwsService) {}

  @ApiDoc({
    summary: 'Upload image files',
    description: 'Image upload successfully',
    status: 200,
  })
  @UseInterceptors(FileInterceptor('image'))
  @Post('/upload')
  @UseGuards(AuthGuard)
  async uploadFile(
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 5 * mbMultiplication })], // 5mb
      })
    )
    file: Express.Multer.File,
    @Req() req: Request
  ): Promise<FileEntity> {
    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('Only image files are allowed');
    }
    const { host } = req.headers;
    return await this.awsService.uploadImage(file, host);
  }

  @ApiDoc({
    summary: 'Get image from bucket',
    description: 'Forward image directly to frontend',
    status: 200,
  })
  @Get('/image/:id')
  async getImageFile(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const response = await this.awsService.getImage(id);
    res.setHeader('Content-Type', response.headers['content-type']);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    response.data.pipe(res);
  }

  @ApiDoc({
    summary: 'Get csv from bucket',
    description: 'Forward csv directly to frontend',
    status: 200,
  })
  @Get('/csv/:id')
  async getCsvFile(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const response = await this.awsService.getCsv(id);
    res.setHeader('Content-Type', response.headers['content-type']);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    response.data.pipe(res);
  }

  @ApiDoc({
    summary: 'Validate and parcing CSV',
    description: 'Image upload successfully',
    status: 200,
  })
  @UseInterceptors(FileInterceptor('csv'))
  @UseGuards(AuthGuard)
  @Post('/handle-csv')
  async handleCsvFiles(
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 5 * mbMultiplication })],
      })
    )
    file: Express.Multer.File
  ): Promise<{ addresses: string[]; total: number }> {
    this.logger.log('csv file received', { fileName: file.originalname, size: file.size });
    return await this.awsService.processWhitelistCsv(file);
  }
}
