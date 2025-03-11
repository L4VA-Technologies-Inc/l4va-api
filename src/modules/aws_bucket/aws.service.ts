import { Injectable, Logger } from '@nestjs/common';
import AWS, { S3 } from 'aws-sdk';
import { v4 as uuid } from 'uuid';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FileEntity } from '../../database/file.entity';
import { ManagedUpload } from 'aws-sdk/clients/s3';
import {getMimeTypeFromArrayBuffer} from "../../helpers";
import {HttpService} from "@nestjs/axios";
import * as process from "process";
import {Express} from "express";

@Injectable()
export class AwsService {
  private s3: AWS.S3;
  private bucketName = process.env.AWS_BUCKET_NAME;

  constructor(
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
    private readonly httpService: HttpService
  ) {}
  getS3() {
    if (this.s3) {
      return this.s3;
    }
    const s3 = new S3({
      region: 'auto',
      endpoint: process.env.AWS_BUCKET_URL, // URL for R2
      signatureVersion: 'v4',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
      s3ForcePathStyle: true,
    });
    this.s3 = s3;
    return s3;
  }

  async uploadS3(file, name, type): Promise<ManagedUpload.SendData> {
    const s3 = this.getS3();
    const params = {
      Bucket: 'static',
      Key: name,
      Body: file,
      ContentType: type,
      ACL: 'public-read',
    };
    return new Promise((resolve, reject) => {
      s3.upload(params, (err, data) => {
        if (err) {
          Logger.error(err);
          reject(err.message);
        }
        resolve(data as ManagedUpload.SendData);
      });
    });
  }

  async getPreSignedURL(bucketName: string, key: string, contentType: string) {
    const s3 = this.getS3();
    const params = {
      Bucket: bucketName,
      Key: key,
      Expires: 3600,
    };

    return s3.getSignedUrlPromise('getObject', params);
  }


  async getImage(bucketKey: string) {

    const preSignedUrl =  await this.getPreSignedURL(this.bucketName, bucketKey, 'image/jpeg');
    return this.httpService.get(preSignedUrl, { responseType: 'stream' }).toPromise();
  }

  async getCsv(bucketKey: string){
    const preSignedUrl =  await this.getPreSignedURL(this.bucketName, bucketKey, 'text/csv');
    return this.httpService.get(preSignedUrl, { responseType: 'stream' }).toPromise();
  }


  async uploadCSV(file: Express.Multer.File, host: string) {
    try {
      const uploadResult = await this.uploadS3(
        file.buffer,
        `${uuid()}`,
        file.mimetype,
      );
      const protocol = process.env.NODE_ENV === 'dev' ? 'http://' :'https://'
      if (uploadResult) {
        const newFile = this.fileRepository.create({
          key: uploadResult.Key,
          url: `${protocol}${host}/api/v1/csv/${uploadResult.Key}`,
          file_name: file.originalname,
          file_type: file.mimetype,
        });
        await this.fileRepository.save(newFile);
        if (newFile) return newFile;
      }
    } catch (error) {
      console.log('error with uploading file ', error);
    }
  }

  async uploadImage(
    file: Express.Multer.File ,
    host: string
  ) {
    try {
      const uploadResult = await this.uploadS3(
        file.buffer,
        `${uuid()}`,
        file.mimetype,
      );
      const protocol = process.env.NODE_ENV === 'dev' ? 'http://' :'https://'
      if (uploadResult) {
        const newFile = this.fileRepository.create({
          key: uploadResult.Key,
          url: `${protocol}${host}/api/v1/image/${uploadResult.Key}`,
          file_name: file.originalname,
          file_type: file.mimetype,
        });
        await this.fileRepository.save(newFile);
        if (newFile) return newFile;
      }
    } catch (error) {
      console.log('error with uploading file ', error);
    }
  }
}
