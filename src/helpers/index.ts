
import { FileEntity } from '../database/file.entity';
import {User} from "../database/user.entity";
import {snakeCase} from "typeorm/util/StringUtils";

export const transformImageToUrl = (imageEntity: FileEntity | null): string | null => {
  return imageEntity?.file_url || null;
};

export const  transformToSnakeCase = (obj: any): any => {
  if (Array.isArray(obj)) {
    return obj.map(item => transformToSnakeCase(item));
  }
  if (obj !== null && typeof obj === 'object' && !(obj instanceof Date) && !(obj instanceof FileEntity) && !(obj instanceof User)) {
    return Object.keys(obj).reduce((acc, key) => {
      const snakeKey = snakeCase(key);
      acc[snakeKey] = transformToSnakeCase(obj[key]);
      return acc;
    }, {});
  }
  return obj;
}

export const getMimeTypeFromArrayBuffer = (arrayBuffer) => {
  const uint8arr = new Uint8Array(arrayBuffer);

  const len = 4;
  if (uint8arr.length >= len) {
    const signatureArr = new Array(len);
    for (let i = 0; i < len; i++)
      signatureArr[i] = new Uint8Array(arrayBuffer)[i].toString(16);
    const signature = signatureArr.join('').toUpperCase();

    switch (signature) {
      case '89504E47':
        return 'image/png';
      case '47494638':
        return 'image/gif';
      case '25504446':
        return 'application/pdf';
      case 'FFD8FFDB':
      case 'FFD8FFE0':
        return 'image/jpeg';
      case '504B0304':
        return 'application/zip';
      default:
        return null;
    }
  }
  return null;
};
