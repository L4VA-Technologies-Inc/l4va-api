import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SnapshotService } from './snapshot.service';

import { Snapshot } from '@/database/snapshot.entity';
import { User } from '@/database/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Snapshot, User])],
  providers: [SnapshotService],
  exports: [SnapshotService],
})
export class SnapshotModule {}
