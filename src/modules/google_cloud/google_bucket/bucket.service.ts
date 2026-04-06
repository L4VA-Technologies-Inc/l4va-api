import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';

import { Storage } from '@google-cloud/storage';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as csv from 'csv-parse';
import sharp from 'sharp';
import { Repository } from 'typeorm';
import { v4 as uuid } from 'uuid';

import { UploadImageDto, ImageResizeMap } from './dto/bucket.dto';

import { FileEntity } from '@/database/file.entity';

@Injectable()
export class GoogleCloudStorageService {
  private readonly storage: Storage;
  private readonly bucketName: string;
  private readonly bucketPrefix: string;
  private readonly appHost: string;
  private readonly ASSET_IMAGES_FOLDER = 'asset-images';

  private readonly logger = new Logger(GoogleCloudStorageService.name);

  constructor(
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService
  ) {
    this.appHost = this.configService.get<string>('APP_HOST');
    if (!this.appHost) {
      throw new Error('APP_HOST environment variable is required');
    }

    const bucketConfig = process.env.GOOGLE_BUCKET_NAME;
    if (!bucketConfig) {
      throw new Error('GOOGLE_BUCKET_NAME environment variable is required');
    }

    const [bucket, ...prefixParts] = bucketConfig.split('/');
    this.bucketName = bucket;
    this.bucketPrefix = prefixParts.length > 0 ? prefixParts.join('/') : '';

    const nodeEnv = process.env.NODE_ENV;
    const isDevelopment = nodeEnv === 'dev' || nodeEnv === 'development';

    // For development: expect file path in GOOGLE_BUCKET_CREDENTIALS
    // For production/testnet: use ADC (Application Default Credentials)
    if (isDevelopment) {
      const credentialsJson = process.env.GOOGLE_BUCKET_CREDENTIALS;
      if (!credentialsJson) {
        throw new Error('GOOGLE_BUCKET_CREDENTIALS environment variable is required for development');
      }

      // Local development: treat GOOGLE_BUCKET_CREDENTIALS as a file path
      const resolvedCredentialsPath = path.resolve(process.cwd(), credentialsJson);

      if (!fs.existsSync(resolvedCredentialsPath)) {
        throw new Error(`GOOGLE_BUCKET_CREDENTIALS file not found at ${resolvedCredentialsPath} (development mode)`);
      }

      const credentialsContent = fs.readFileSync(resolvedCredentialsPath, 'utf8');
      const credentials = JSON.parse(credentialsContent);
      this.storage = new Storage({
        credentials: credentials,
        projectId: credentials.project_id,
      });
      this.logger.log('✅ Initialized Google Cloud Storage from file (dev mode)');
    } else {
      // Production/Testnet: use ADC (VM service account)
      this.storage = new Storage();
      this.logger.log('✅ Initialized Google Cloud Storage with ADC (VM service account)');
    }
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
    if (!bucketKey || typeof bucketKey !== 'string') {
      throw new BadRequestException(`Invalid file key: ${bucketKey}`);
    }

    const fileName = this.getFullPath(bucketKey);
    if (!fileName || typeof fileName !== 'string') {
      throw new BadRequestException(`Invalid file path for key: ${bucketKey}`);
    }

    let contentType = 'application/octet-stream';
    try {
      const fileEntity = await this.fileRepository.findOne({
        where: { file_key: bucketKey },
      });
      if (fileEntity && fileEntity.file_type) {
        contentType = fileEntity.file_type;
      }
    } catch (dbError) {
      this.logger.warn(`Could not get file type from database for ${bucketKey}: ${dbError.message}`);
    }

    try {
      const storage = this.getStorage();
      if (!storage) {
        throw new Error('Storage is not initialized');
      }

      const bucket = storage.bucket(this.bucketName);
      if (!bucket) {
        throw new Error('Bucket is not initialized');
      }

      const filePath = String(fileName).trim();
      if (!filePath) {
        throw new Error('File path is empty');
      }

      const file = bucket.file(filePath);
      if (!file) {
        throw new Error('File object is not created');
      }

      const stream = file.createReadStream({
        validation: false,
      });

      stream.on('error', streamError => {
        this.logger.error(`Stream error for ${bucketKey}: ${streamError.message}`, streamError);
      });

      return {
        stream,
        contentType,
      };
    } catch (error) {
      if (error.code === 404 || error.message?.includes('No such object')) {
        throw new BadRequestException(`Image with key ${bucketKey} not found`);
      }
      throw new BadRequestException(`Failed to retrieve image: ${error.message}`);
    }
  }

  async getCsv(bucketKey: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string }> {
    if (!bucketKey || typeof bucketKey !== 'string') {
      throw new BadRequestException(`Invalid file key: ${bucketKey}`);
    }

    const fileName = this.getFullPath(bucketKey);
    if (!fileName || typeof fileName !== 'string') {
      throw new BadRequestException(`Invalid file path for key: ${bucketKey}`);
    }

    let contentType = 'text/csv';
    try {
      const fileEntity = await this.fileRepository.findOne({
        where: { file_key: bucketKey },
      });
      if (fileEntity && fileEntity.file_type) {
        contentType = fileEntity.file_type;
      }
    } catch (dbError) {
      this.logger.warn(`Could not get file type from database for ${bucketKey}: ${dbError.message}`);
    }

    try {
      const bucket = this.getStorage().bucket(this.bucketName);

      if (!bucket) {
        throw new Error('Bucket is not initialized');
      }

      const file = bucket.file(fileName);

      if (!file) {
        throw new Error('File object is not created');
      }

      const stream = file.createReadStream();

      stream.on('error', streamError => {
        this.logger.error(`Stream error for CSV ${bucketKey}: ${streamError.message}`);
      });

      return {
        stream,
        contentType,
      };
    } catch (error) {
      this.logger.error(`Error getting CSV ${bucketKey}: ${error.message}`, error);
      if (error.code === 404 || error.message?.includes('No such object')) {
        throw new BadRequestException(`CSV with key ${bucketKey} not found`);
      }
      throw new BadRequestException(`Failed to retrieve CSV: ${error.message}`);
    }
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

  async uploadImage(file: Express.Multer.File, body?: UploadImageDto): Promise<FileEntity> {
    try {
      let processedImageBuffer: Buffer;

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
      } else {
        processedImageBuffer = await sharp(file.buffer)
          .webp({
            quality: 80,
            lossless: false,
            alphaQuality: 80,
          })
          .toBuffer();
      }
      const mimeType = 'image/webp';
      const fileKey = `${uuid()}`;
      const uploadResult = await this.uploadFile(processedImageBuffer, fileKey, mimeType);
      const protocol = process.env.NODE_ENV === 'dev' ? 'http://' : 'https://';

      if (!uploadResult) throw new BadRequestException('Failed to upload file to Google Cloud Storage');

      const fileUrl = `${protocol}${this.appHost}/api/v1/image/${uploadResult.Key}`;
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

  /** Decodes `data:*;base64,...` payload into a buffer. */
  private bufferFromDataUrl(dataUrl: string): Buffer | null {
    const comma = dataUrl.indexOf(',');
    if (comma === -1) {
      return null;
    }
    const metadata = dataUrl.slice(0, comma);
    if (!/;base64$/i.test(metadata)) {
      return null;
    }
    const b64 = dataUrl.slice(comma + 1).replace(/\s/g, '');
    try {
      return Buffer.from(b64, 'base64');
    } catch {
      return null;
    }
  }

  /**
   * Downloads/decodes an asset image, converts it to WebP
   * (animated WebP for GIFs/WebPs), and stores it under `asset-images/` in GCS.
   *
   * Supports `ipfs://...`, `http(s)://...`, and `data:image/...;base64,...` sources.
   *
   * @param imageUrl - Source image URL or data URL.
   * @returns `ipfs://{id}` handle used by the app (mapped to `asset-images/{id}` in GCS),
   *          or `null` when decoding/downloading/conversion/upload fails.
   */
  async uploadAssetImage(imageUrl: string): Promise<string | null> {
    try {
      if (!imageUrl) return null;

      let imageBuffer: Buffer;
      let objectId: string;
      let contentType = '';

      if (imageUrl.startsWith('data:')) {
        const decoded = this.bufferFromDataUrl(imageUrl);
        if (!decoded?.length) {
          return null;
        }
        imageBuffer = decoded;
        objectId = crypto.createHash('sha256').update(imageBuffer).digest('hex');
        const mimeMatch = imageUrl.match(/^data:([^;,]+)/i);
        contentType = mimeMatch?.[1]?.toLowerCase() ?? '';
      } else {
        const cid = imageUrl.split('/').pop()?.split('?')[0];
        if (!cid) return null;

        objectId = cid;

        const fetchUrl = imageUrl.startsWith('ipfs://') ? `https://ipfs.blockfrost.dev/ipfs/${cid}` : imageUrl;

        const response = await this.httpService.axiosRef.get<ArrayBuffer>(fetchUrl, {
          responseType: 'arraybuffer',
          timeout: 30_000,
        });

        imageBuffer = Buffer.from(response.data);
        contentType = String(response.headers['content-type'] ?? '').toLowerCase();
      }

      const bucketKey = `${this.ASSET_IMAGES_FOLDER}/${objectId}`;

      const existingFile = await this.fileRepository.findOne({
        where: { file_key: bucketKey },
      });

      if (existingFile) {
        return `ipfs://${objectId}`;
      }

      const isAnimated = contentType.includes('gif') || contentType.includes('webp');

      const webpBuffer = await sharp(imageBuffer, { animated: isAnimated })
        .resize(128, 128, { fit: 'inside' })
        .webp({ quality: 80, lossless: false, alphaQuality: 80 })
        .toBuffer();

      const uploadResult = await this.uploadFile(webpBuffer, bucketKey, 'image/webp');

      if (!uploadResult) {
        return null;
      }

      const fileUrl = `ipfs://${objectId}`;

      const newFile = this.fileRepository.create({
        file_key: bucketKey,
        file_url: fileUrl,
        file_name: `${objectId}.webp`,
        file_type: 'image/webp',
      });
      await this.fileRepository.save(newFile);

      return `ipfs://${objectId}`;
    } catch (error) {
      return null;
    }
  }

  async getAssetImage(id: string): Promise<{ stream: NodeJS.ReadableStream; contentType: string }> {
    const bucketKey = `${this.ASSET_IMAGES_FOLDER}/${id}`;
    const fileName = this.getFullPath(bucketKey);

    try {
      const bucket = this.getStorage().bucket(this.bucketName);
      const stream = bucket.file(fileName).createReadStream({ validation: false });

      stream.on('error', err => {
        this.logger.error(`Stream error for asset image ${id}:`, err);
      });

      return { stream, contentType: 'image/webp' };
    } catch (error) {
      if (error.code === 404 || error.message?.includes('No such object')) {
        throw new BadRequestException(`Asset image ${id} not found`);
      }
      throw new BadRequestException(`Failed to retrieve asset image: ${error.message}`);
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

  async deleteFile(fileKey: string): Promise<void> {
    if (!fileKey || typeof fileKey !== 'string') {
      throw new BadRequestException(`Invalid file key: ${fileKey}`);
    }

    const trimmedKey = fileKey.trim();
    if (!trimmedKey) {
      throw new BadRequestException('Invalid file key: empty');
    }

    const fileName = this.getFullPath(trimmedKey);

    try {
      const storage = this.getStorage();
      if (!storage) {
        throw new Error('Storage is not initialized');
      }

      const bucket = storage.bucket(this.bucketName);
      if (!bucket) {
        throw new Error('Bucket is not initialized');
      }

      await bucket.file(fileName).delete({ ignoreNotFound: true });

      await this.fileRepository.delete({ file_key: trimmedKey });

      this.logger.log(`Deleted file ${trimmedKey} (${fileName})`);
    } catch (error) {
      this.logger.error(`Failed to delete file ${trimmedKey}: ${error.message}`, error);
      throw new BadRequestException(`Failed to delete file: ${error.message}`);
    }
  }
}
