import * as process from 'process';

import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import AWS, { S3 } from 'aws-sdk';
import { ManagedUpload } from 'aws-sdk/clients/s3';
import * as csv from 'csv-parse';
import sharp from 'sharp';
import { Repository } from 'typeorm';
import { v4 as uuid } from 'uuid';

import { FileEntity } from '@/database/file.entity';
import { AwsUploadImageDto, ImageResizeMap } from '@/modules/aws_bucket/dto/aws.dto';

@Injectable()
export class AwsService {
  private s3: AWS.S3;
  private bucketName = process.env.AWS_BUCKET_NAME;

  private readonly logger = new Logger(AwsService.name);
  constructor(
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
    private readonly httpService: HttpService
  ) {}
  getS3(): AWS.S3 {
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

  async getPreSignedURL(bucketName: string, key: string): Promise<string> {
    const s3 = this.getS3();
    const params = {
      Bucket: bucketName,
      Key: key,
      Expires: 3600,
    };

    return s3.getSignedUrlPromise('getObject', params);
  }

  async getImage(bucketKey: string) {
    const preSignedUrl = await this.getPreSignedURL(this.bucketName, bucketKey);
    return this.httpService.get(preSignedUrl, { responseType: 'stream' }).toPromise();
  }

  // TODO: Remove csv upload to S3
  async getCsv(bucketKey: string) {
    const preSignedUrl = await this.getPreSignedURL(this.bucketName, bucketKey);
    return this.httpService.get(preSignedUrl, { responseType: 'stream' }).toPromise();
  }

  private async validateCsvAddresses(buffer: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const addresses: string[] = [];
      const cardanoAddressRegex = /^addr1[a-zA-Z0-9]{98}$/;

      csv
        .parse(buffer.toString(), {
          columns: false,
          skip_empty_lines: true,
          trim: true,
        })
        .on('data', data => {
          const address = data[0];
          if (!address || typeof address !== 'string' || !cardanoAddressRegex.test(address)) {
            reject(
              new BadRequestException(
                `Invalid Cardano address format found in CSV: ${address}. Address must be a valid Cardano Shelley address starting with 'addr1' and containing 98 alphanumeric characters`
              )
            );
          }
          addresses.push(address);
        })
        .on('end', () => {
          if (addresses.length === 0) {
            reject(new BadRequestException('CSV file is empty or contains no valid addresses'));
          }
          resolve();
        })
        .on('error', error => {
          reject(new BadRequestException(`Error parsing CSV: ${error.message}`));
        });
    });
  }

  async uploadCSV(file: Express.Multer.File, host: string) {
    try {
      // Validate CSV content before uploading
      await this.validateCsvAddresses(file.buffer);

      const uploadResult = await this.uploadS3(file.buffer, `${uuid()}`, file.mimetype);
      const protocol = process.env.NODE_ENV === 'dev' ? 'http://' : 'https://';
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
      this.logger.error('Error uploading CSV file:', error);
      throw new BadRequestException('Failed to upload CSV file');
    }
  }

  async uploadImage(file: Express.Multer.File, host: string, body?: AwsUploadImageDto) {
    try {
      let processedImageBuffer = file.buffer;
      let mimeType = file.mimetype;

      const imageType = body?.imageType;
      const resizeParams = imageType ? ImageResizeMap[imageType] : null;

      if (resizeParams) {
        processedImageBuffer = await sharp(file.buffer)
          .resize(resizeParams.width, resizeParams.height, {
            fit: 'cover',
            position: 'center',
          })
          .webp({
            quality: 80,
            lossless: false,
            alphaQuality: 80,
          })
          .toBuffer();

        mimeType = 'image/webp';
      }

      const uploadResult = await this.uploadS3(processedImageBuffer, `${uuid()}`, mimeType);
      const protocol = process.env.NODE_ENV === 'dev' ? 'http://' : 'https://';

      if (!uploadResult) throw new BadRequestException('Failed to upload file to S3');

      const newFile = this.fileRepository.create({
        file_key: uploadResult.Key,
        file_url: `${protocol}${host}/api/v1/image/${uploadResult.Key}`,
        file_name: file.originalname,
        file_type: mimeType,
      });

      await this.fileRepository.save(newFile);
      return newFile;
    } catch (error) {
      this.logger.error('Error uploading image file:', error);
      throw new BadRequestException('Failed to upload image file');
    }
  }

  /**
   * Creates a new file record in the database for a vault, referencing an existing S3 object.
   *
   * @param fileKey - The S3 key of the original file to reference.
   * @returns A promise that resolves to the newly created FileEntity.
   * @throws {BadRequestException} If the original file with the given key is not found.
   */
  async createFileRecordForVault(fileKey: string): Promise<FileEntity> {
    // Find the original file to get its metadata
    const originalFile = await this.fileRepository.findOne({
      where: { file_key: fileKey },
    });

    if (!originalFile) {
      throw new BadRequestException(`File with key ${fileKey} not found`);
    }

    // Create a new file entity that points to the same S3 object
    const newFile = this.fileRepository.create({
      file_key: originalFile.file_key, // Same S3 key
      file_url: originalFile.file_url,
      file_name: originalFile.file_name,
      file_type: originalFile.file_type,
    });

    // Save and return the new file entity
    return this.fileRepository.save(newFile);
  }
}
