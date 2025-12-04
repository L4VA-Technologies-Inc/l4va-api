import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

import { Snapshot } from '@/database/snapshot.entity';

export class CreateSnapshotRes {
  @Expose()
  @ApiProperty({ description: 'Created snapshot entity', type: Snapshot })
  snapshot: Snapshot;
}
