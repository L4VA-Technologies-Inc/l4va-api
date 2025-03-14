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
import * as csv from 'csv-parse';
import { BadRequestException } from '@nestjs/common';

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


  private async validateCsvAddresses(buffer: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const addresses: string[] = [];
      const cardanoAddressRegex = /^addr1[a-zA-Z0-9]{98}$/;

      csv.parse(buffer.toString(), {
        columns: false,
        skip_empty_lines: true,
        trim: true
      })
      .on('data', (data) => {
        const address = data[0];
        if (!address || typeof address !== 'string' || !cardanoAddressRegex.test(address)) {
          reject(new BadRequestException(`Invalid Cardano address format found in CSV: ${address}. Address must be a valid Cardano Shelley address starting with 'addr1' and containing 98 alphanumeric characters`));
        }
        addresses.push(address);
      })
      .on('end', () => {
        if (addresses.length === 0) {
          reject(new BadRequestException('CSV file is empty or contains no valid addresses'));
        }
        resolve();
      })
      .on('error', (error) => {
        reject(new BadRequestException(`Error parsing CSV: ${error.message}`));
      });
    });
  }

  async uploadCSV(file: Express.Multer.File, host: string) {
    try {
      // Validate CSV content before uploading
      await this.validateCsvAddresses(file.buffer);

      const uploadResult = await this.uploadS3(
        file.buffer,
        `${uuid()}`,
        file.mimetype,
      );
      const protocol = process.env.NODE_ENV === 'dev' ? 'http://' :'https://'
      if (uploadResult) {
        const newFile = this.fileRepository.create({
          file_key: uploadResult.Key,
          file_url: `${protocol}${host}/api/v1/csv/${uploadResult.Key}`,
          file_name: file.originalname,
          file_type: file.mimetype,
        });
        await this.fileRepository.save(newFile);
        if (newFile) return newFile;
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error; // Re-throw validation errors
      }
      Logger.error('Error uploading CSV file:', error);
      throw new BadRequestException('Failed to upload CSV file');
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
          file_key: uploadResult.Key,
          file_url: `${protocol}${host}/api/v1/image/${uploadResult.Key}`,
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
