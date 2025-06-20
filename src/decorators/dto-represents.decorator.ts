import { applyDecorators } from '@nestjs/common';
import { Expose, ExposeOptions, Transform } from 'class-transformer';

interface DtoRepresentsType {
  transform: any;
  expose: ExposeOptions;
}

export function DtoRepresent({ transform, expose }: DtoRepresentsType) {
  return applyDecorators(transform ? Transform(transform) : () => {}, expose ? Expose(expose) : () => {});
}
