import * as path from 'path';
import * as process from 'process';

import { Storage } from '@google-cloud/storage';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as csv from 'csv-parse';
import sharp from 'sharp';
import { Repository } from 'typeorm';
import { v4 as uuid } from 'uuid';

import { UploadImageDto, ImageResizeMap } from './dto/bucket.dto';

import { FileEntity } from '@/database/file.entity';

@Injectable()
export class GoogleCloudStorageService {
  private storage: Storage;
  private bucketName: string;
  private bucketPrefix: string;

  private readonly logger = new Logger(GoogleCloudStorageService.name);

  constructor(
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
    private readonly httpService: HttpService
  ) {
    const credentialsPath = process.env.GOOGLE_BUCKET_CREDENTIALS;
    const bucketConfig = process.env.GOOGLE_BUCKET_NAME;

    if (!credentialsPath) {
      throw new Error('GOOGLE_BUCKET_CREDENTIALS environment variable is required');
    }
    if (!bucketConfig) {
      throw new Error('GOOGLE_BUCKET_NAME environment variable is required');
    }

    const [bucket, ...prefixParts] = bucketConfig.split('/');
    this.bucketName = bucket;
    this.bucketPrefix = prefixParts.length > 0 ? prefixParts.join('/') : '';

    this.storage = new Storage({
      keyFilename: path.resolve(process.cwd(), credentialsPath),
    });

    this.logger.log(
      `Initialized Google Cloud Storage with bucket: ${this.bucketName}, prefix: ${this.bucketPrefix || 'none'}`
    );
  }

  private getStorage(): Storage {
    return this.storage;
  }

  private getFullPath(key: string): string {
    return this.bucketPrefix ? `${this.bucketPrefix}/${key}` : key;
  }

  async uploadFile(buffer: Buffer, name: string, type: string): Promise<{ Key: string; Location: string }> {
    const bucket = this.getStorage().bucket(this.bucketName);
    const fileName = this.getFullPath(name);
    const gcsFile = bucket.file(fileName);

    return new Promise((resolve, reject) => {
      const stream = gcsFile.createWriteStream({
        metadata: {
          contentType: type,
        },
      });

      stream.on('error', err => {
        this.logger.error('Error uploading file:', err);
        reject(err.message);
      });

      stream.on('finish', async () => {
        try {
          resolve({
            Key: name,
            Location: `gs://${this.bucketName}/${fileName}`,
          });
        } catch (err) {
          this.logger.error('Error finalizing upload:', err);
          reject(err.message);
        }
      });

      stream.end(buffer);
    });
  }

  async getSignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    const bucket = this.getStorage().bucket(this.bucketName);
    const fileName = this.getFullPath(key);
    const file = bucket.file(fileName);

    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + expiresIn * 1000,
    });

    return url;
  }

  async getImage(bucketKey: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string }> {
    const bucket = this.getStorage().bucket(this.bucketName);
    const fileName = this.getFullPath(bucketKey);
    const file = bucket.file(fileName);

    this.logger.log(`Attempting to get image. Bucket: ${this.bucketName}, Full path: ${fileName}, Key: ${bucketKey}`);

    const [exists] = await file.exists();
    if (!exists) {
      this.logger.warn(`Image not found. Bucket: ${this.bucketName}, Full path: ${fileName}, Key: ${bucketKey}`);
      throw new BadRequestException(`Image with key ${bucketKey} not found`);
    }

    const [metadata] = await file.getMetadata();
    const contentType = metadata.contentType || 'application/octet-stream';
    this.logger.log(`Image found. Content type: ${contentType}`);

    const stream = file.createReadStream();

    return {
      stream,
      contentType,
    };
  }

  async getCsv(bucketKey: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string }> {
    const bucket = this.getStorage().bucket(this.bucketName);
    const fileName = this.getFullPath(bucketKey);
    const file = bucket.file(fileName);

    const [exists] = await file.exists();
    if (!exists) {
      throw new BadRequestException(`CSV with key ${bucketKey} not found`);
    }

    const [metadata] = await file.getMetadata();
    const contentType = metadata.contentType || 'text/csv';

    const stream = file.createReadStream();

    return {
      stream,
      contentType,
    };
  }

  async parseCsvAddresses(buffer: Buffer): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      const addresses: string[] = [];
      const cardanoAddressRegex = /^addr(_test)?1[a-z0-9]{20,}$/i;
      let addressColumnIndex = 0;
      let headersProcessed = false;

      csv
        .parse(buffer.toString(), {
          columns: false,
          skip_empty_lines: true,
          trim: true,
        })
        .on('data', data => {
          if (!headersProcessed) {
            const normalizedHeaders = data.map(value => (typeof value === 'string' ? value.trim().toLowerCase() : ''));
            const foundIndex = normalizedHeaders.findIndex(
              header => header === 'address' || header.includes('address')
            );
            addressColumnIndex = foundIndex >= 0 ? foundIndex : 0;
            headersProcessed = true;
            return;
          }

          const address = typeof data[addressColumnIndex] === 'string' ? data[addressColumnIndex].trim() : '';
          if (!address) {
            return;
          }
          if (!cardanoAddressRegex.test(address)) {
            return;
          }
          addresses.push(address);
        })
        .on('end', () => {
          if (addresses.length === 0) {
            reject(new BadRequestException('CSV file is empty or contains no valid addresses'));
          }
          resolve(addresses);
        })
        .on('error', error => {
          reject(new BadRequestException(`Error parsing CSV: ${error.message}`));
        });
    });
  }

  async processWhitelistCsv(file: Express.Multer.File): Promise<{ addresses: string[]; total: number }> {
    try {
      const isCsv =
        file.mimetype?.includes('csv') ||
        file.originalname.toLowerCase().endsWith('.csv') ||
        file.mimetype === 'application/vnd.ms-excel';
      if (!isCsv) {
        throw new BadRequestException('Only CSV files are allowed');
      }

      const addresses = await this.parseCsvAddresses(file.buffer);
      return { addresses, total: addresses.length };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error('Error processing CSV file:', error);
      throw new BadRequestException('Failed to process CSV file');
    }
  }

  async uploadImage(file: Express.Multer.File, host: string, body?: UploadImageDto): Promise<FileEntity> {
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

      const fileKey = `${uuid()}`;
      const uploadResult = await this.uploadFile(processedImageBuffer, fileKey, mimeType);
      const protocol = process.env.NODE_ENV === 'dev' ? 'http://' : 'https://';

      if (!uploadResult) throw new BadRequestException('Failed to upload file to Google Cloud Storage');

      const fileUrl = `${protocol}${host}/api/v1/image/${uploadResult.Key}`;
      this.logger.log(`File uploaded successfully. Key: ${uploadResult.Key}, URL: ${fileUrl}`);

      const newFile = this.fileRepository.create({
        file_key: uploadResult.Key,
        file_url: fileUrl,
        file_name: file.originalname,
        file_type: mimeType,
      });

      await this.fileRepository.save(newFile);
      this.logger.log(`File entity saved with ID: ${newFile.id}`);
      return newFile;
    } catch (error) {
      this.logger.error('Error uploading image file:', error);
      throw new BadRequestException('Failed to upload image file');
    }
  }

  /**
   * Creates a new file record in the database for a vault, referencing an existing GCS object.
   *
   * @param fileKey - The GCS key of the original file to reference.
   * @returns A promise that resolves to the newly created FileEntity.
   * @throws {BadRequestException} If the original file with the given key is not found.
   */
  async createFileRecordForVault(fileKey: string): Promise<FileEntity> {
    const originalFile = await this.fileRepository.findOne({
      where: { file_key: fileKey },
    });

    if (!originalFile) {
      throw new BadRequestException(`File with key ${fileKey} not found`);
    }

    const newFile = this.fileRepository.create({
      file_key: originalFile.file_key,
      file_url: originalFile.file_url,
      file_name: originalFile.file_name,
      file_type: originalFile.file_type,
    });

    return this.fileRepository.save(newFile);
  }
}
