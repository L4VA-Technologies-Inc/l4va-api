import {
  ClassSerializerInterceptor,
  Controller,
  FileTypeValidator,
  Get, MaxFileSizeValidator, Param, ParseFilePipe,
  Post, Req, Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {ApiTags} from "@nestjs/swagger";
import {AwsService} from "./aws.service";
import {ApiDoc} from "../../decorators/api-doc.decorator";
import {FileInterceptor} from "@nestjs/platform-express";
import { Express, Response, Request } from 'express'

const mbMultiplication =  1024 * 1024;

@ApiTags('files')
@Controller('')
@UseInterceptors(ClassSerializerInterceptor)
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
        new MaxFileSizeValidator({ maxSize: 5 * mbMultiplication }), // 5mb
        new FileTypeValidator({ fileType: 'image/jpeg' }),
      ],
    }),
  ) file: Express.Multer.File, @Req() req: Request) {
    const {host} = req?.headers
   return await this.awsService.uploadImage(file, host)
  }

  @ApiDoc({
    summary: 'Get image from bucket',
    description: 'Forward image directly to frontend',
    status: 200,
  })
  @Get('/image/:id')
  async getImageFile(@Param('id') id,  @Res() res: Response ){
    const response = await this.awsService.getImage(id)
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
  async getCsvFile(@Param('id') id,  @Res() res: Response ){
    const response = await this.awsService.getCsv(id)
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
  @Post('/handle-csv')
  async handleCsvFiles(@UploadedFile(
    new ParseFilePipe({
      validators: [
        new MaxFileSizeValidator({ maxSize: 10000 }),
        new FileTypeValidator({ fileType: 'text/csv' }),
      ],
    }),
  ) file: Express.Multer.File, @Req() req: Request){
    // todo need to validate and parse csv and then return list of asset whitelist id's
    console.log('csv file received', file)
    const {host} = req?.headers

    return await this.awsService.uploadCSV(file, host)
  }
}
