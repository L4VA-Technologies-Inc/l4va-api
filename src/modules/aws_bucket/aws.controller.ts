import {
  BadRequestException,
  Body,
  Controller,
  FileTypeValidator,
  Get, MaxFileSizeValidator, Param, ParseFilePipe,
  Post, Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {ApiTags} from "@nestjs/swagger";
import {AwsService} from "./aws.service";
import {ApiDoc} from "../../decorators/api-doc.decorator";
import {FileInterceptor} from "@nestjs/platform-express";
import { Express, Response } from 'express'



@ApiTags('files')
@Controller('')
export class AwsController {

  constructor(private readonly awsService: AwsService){}

  @ApiDoc({
    summary: 'Upload image files',
    description: 'Image upload successfully',
    status: 200,
  })
  @UseInterceptors(FileInterceptor('image'))
  @Post('/upload')
  async uploadFile(@UploadedFile(
    new ParseFilePipe({
      validators: [
        new MaxFileSizeValidator({ maxSize: 10000 }),
        new FileTypeValidator({ fileType: 'image/jpeg' }),
      ],
    }),
  ) file: Express.Multer.File) {
   return await this.awsService.uploadImage(file.buffer as ArrayBuffer)
  }

  @Get('/image/:id')
  async getFile(@Param('id') id,  @Res() res: Response){
    const response = await this.awsService.downloadLink(id)
    res.setHeader('Content-Type', response.headers['content-type']);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    response.data.pipe(res);
  }

  @Post('/handle-csv')
  handleCsvFiles(){}
}
