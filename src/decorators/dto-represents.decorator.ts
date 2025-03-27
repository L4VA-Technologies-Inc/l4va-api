import { applyDecorators } from '@nestjs/common';
import {Expose, Transform} from "class-transformer";

interface DtoRepresentsType {
  transform: any
  expose: any
}

export function DtoRepresent({ transform, expose}: DtoRepresentsType) {
  return applyDecorators(
    !!transform ? Transform(transform): () => {},
   !!expose ? Expose(expose): () => {}
  );
}
