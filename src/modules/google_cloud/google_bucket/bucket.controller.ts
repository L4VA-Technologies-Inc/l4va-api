import {
  BadRequestException,
  Body,
  ClassSerializerInterceptor,
  Controller,
  Get,
  Logger,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  ParseUUIDPipe,
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

import { AuthGuard } from '../../auth/auth.guard';

import { GoogleCloudStorageService } from './bucket.service';
import { UploadImageDto } from './dto/bucket.dto';

import { FileEntity } from '@/database/file.entity';
import { ApiDoc } from '@/decorators/api-doc.decorator';

export const mbMultiplication = 1024 * 1024;

@ApiTags('files')
@Controller('')
@UseInterceptors(ClassSerializerInterceptor)
export class GoogleCloudStorageController {
  private readonly logger = new Logger(GoogleCloudStorageController.name);
  constructor(private readonly gcsService: GoogleCloudStorageService) {}

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
    @Req() req: Request,
    @Body() body: UploadImageDto
  ): Promise<FileEntity> {
    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('Only image files are allowed');
    }
    const { host } = req.headers;
    return await this.gcsService.uploadImage(file, host, body);
  }

  @ApiDoc({
    summary: 'Get image from bucket',
    description: 'Forward image directly to frontend',
    status: 200,
  })
  @Get('/image/:id')
  async getImageFile(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    try {
      const { stream, contentType } = await this.gcsService.getImage(id);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');

      stream.on('error', error => {
        this.logger.error(`Error streaming image ${id}:`, error);
        if (!res.headersSent) {
          res.status(500).json({ message: 'Error streaming image' });
        }
      });

      stream.pipe(res);
    } catch (error) {
      this.logger.error(`Error getting image ${id}:`, error);
      if (!res.headersSent) {
        res.status(404).json({ message: error.message || 'Image not found' });
      }
    }
  }

  @ApiDoc({
    summary: 'Get csv from bucket',
    description: 'Forward csv directly to frontend',
    status: 200,
  })
  @Get('/csv/:id')
  async getCsvFile(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const { stream, contentType } = await this.gcsService.getCsv(id);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    stream.pipe(res);
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
    return await this.gcsService.processWhitelistCsv(file);
  }
}
