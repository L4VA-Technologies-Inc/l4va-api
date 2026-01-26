import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CreatePresetReq } from './dto/createPreset.req';

import { User } from '@/database/user.entity';
import { VaultPreset } from '@/database/vaultPreset.entity';
import { VaultPresetType } from '@/types/vault.types';

@Injectable()
export class PresetsService {
  private readonly logger = new Logger(PresetsService.name);

  constructor(
    @InjectRepository(VaultPreset)
    private presetRepository: Repository<VaultPreset>,
    @InjectRepository(User)
    private usersRepository: Repository<User>
  ) {}
  async getAllPresets(userId: string): Promise<VaultPreset[]> {
    const user = await this.usersRepository.findOneBy({ id: userId });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const order = Object.values(VaultPresetType);

    const orderByCase = order.map((type, index) => `WHEN preset.type = '${type}' THEN ${index}`).join(' ');

    return this.presetRepository
      .createQueryBuilder('preset')
      .where('preset.user_id IS NULL')
      .orWhere('preset.user_id = :userId', { userId })
      .orderBy(`CASE ${orderByCase} ELSE ${order.length} END`, 'ASC')
      .addOrderBy('preset.created_at', 'DESC')
      .getMany();
  }

  async createPreset(userId: string, data: CreatePresetReq): Promise<VaultPreset> {
    const user = await this.usersRepository.findOneBy({ id: userId });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const preset = this.presetRepository.create({
      name: data.name,
      type: VaultPresetType.custom,
      config: data.config ?? null,
      user_id: userId,
    });

    return this.presetRepository.save(preset);
  }

  async deletePreset(userId: string, presetId: string): Promise<void> {
    const user = await this.usersRepository.findOneBy({ id: userId });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const preset = await this.presetRepository.findOneBy({ id: presetId });

    if (!preset) {
      throw new NotFoundException('Preset not found');
    }

    if (!preset.user_id) {
      throw new ForbiddenException('Cannot delete base preset');
    }

    if (preset.user_id !== userId) {
      throw new ForbiddenException('Preset does not belong to the user');
    }

    await this.presetRepository.delete({ id: presetId });
  }
}
