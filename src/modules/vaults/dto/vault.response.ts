import { ApiProperty } from '@nestjs/swagger';
import { Expose, Transform } from 'class-transformer';
import { VaultPrivacy, VaultStatus, VaultType, ValuationType } from '../../../types/vault.types';
import { LinkEntity } from '../../../database/link.entity';

export class VaultShortResponse {
  @ApiProperty({ description: 'Unique identifier of the vault' })
  @Expose()
  id: string;

  @ApiProperty({ description: 'Name of the vault' })
  @Expose()
  name: string;

  @ApiProperty({ description: 'Description of the vault', required: false })
  @Expose()
  description?: string;

  @ApiProperty({ description: 'Tvl', required: false})
  @Expose()
  @Transform(({ value }) => value ? Number(value) : null)
  tvl?: number;


  @ApiProperty({ description: 'Tvl', required: false})
  @Expose()
  @Transform(({ value }) => value ? Number(value) : null)
  baseAllocation?:number;


  @ApiProperty({ description: 'Tvl', required: false})
  @Expose()
  @Transform(({ value }) => value ? Number(value) : null)
  total?: number;


  @ApiProperty({ description: 'Tvl', required: false})
  @Expose()
  @Transform(({ value }) => value ? Number(value) : null)
  invested?: number;

  @ApiProperty({ description: 'Privacy setting of the vault', enum: VaultPrivacy })
  @Expose()
  privacy: VaultPrivacy;

  @ApiProperty({ description: 'Timestamp when contribution phase starts', required: false })
  @Expose()
  @Transform(({ value }) => value ? new Date(value).toISOString() : null)
  contributionStartTime?: string;

  @ApiProperty({ description: 'Timestamp when contribution phase ends', required: false })
  @Expose()
  @Transform(({ value }) => value ? new Date(value).toISOString() : null)
  contributionEndTime?: string;

  @ApiProperty({ description: 'Time remaining until contribution starts in milliseconds', required: false })
  @Expose()
  @Transform(({ obj }) => {
    if (!obj.contributionStartTime) return null;
    const now = new Date();
    const startTime = new Date(obj.contributionStartTime);
    const diff = startTime.getTime() - now.getTime();
    return diff > 0 ? diff : 0;
  })
  timeToContributionStart?: number;

  @ApiProperty({ description: 'Time remaining in contribution phase in milliseconds', required: false })
  @Expose()
  @Transform(({ obj }) => {
    if (!obj.contributionEndTime) return null;
    const now = new Date();
    const endTime = new Date(obj.contributionEndTime);
    const diff = endTime.getTime() - now.getTime();
    return diff > 0 ? diff : 0;
  })
  contributionTimeRemaining?: number;

  @ApiProperty({ description: 'Timestamp when investment phase starts', required: false })
  @Expose()
  @Transform(({ value }) => value ? new Date(value).toISOString() : null)
  investmentStartTime?: string;

  @ApiProperty({ description: 'Timestamp when investment phase ends', required: false })
  @Expose()
  @Transform(({ value }) => value ? new Date(value).toISOString() : null)
  investmentEndTime?: string;

  @ApiProperty({ description: 'Time remaining until investment starts in milliseconds', required: false })
  @Expose()
  @Transform(({ obj }) => {
    if (!obj.investmentStartTime) return null;
    const now = new Date();
    const startTime = new Date(obj.investmentStartTime);
    const diff = startTime.getTime() - now.getTime();
    return diff > 0 ? diff : 0;
  })
  timeToInvestmentStart?: number;

  @ApiProperty({ description: 'Time remaining in investment phase in milliseconds', required: false })
  @Expose()
  @Transform(({ obj }) => {
    if (!obj.investmentEndTime) return null;
    const now = new Date();
    const endTime = new Date(obj.investmentEndTime);
    const diff = endTime.getTime() - now.getTime();
    return diff > 0 ? diff : 0;
  })
  investmentTimeRemaining?: number;

  @ApiProperty({ description: 'Vault image', required: true })
  @Expose()
  vaultImage?: string;

  @ApiProperty({ description: 'Banner image', required:true })
  @Expose()
  bannerImage?: string;

  @ApiProperty({ description: 'Social links', type: [LinkEntity], required: false })
  @Expose({ name: 'socialLinks' })
  socialLinks?: LinkEntity[];
}

export class VaultFullResponse extends VaultShortResponse {

  @ApiProperty({ description: 'Type of the vault', enum: VaultType })
  @Expose()
  type: VaultType;

  @ApiProperty({ description: 'Status of the vault', enum: VaultStatus })
  @Expose()
  vaultStatus: VaultStatus;

  @ApiProperty({ description: 'Valuation type', enum: ValuationType, required: false })
  @Expose({ name: 'valuationType' })
  valuationType?: ValuationType;

  @ApiProperty({ description: 'Valuation currency', required: false })
  @Expose({ name: 'valuationCurrency' })
  valuationCurrency?: string;

  @ApiProperty({ description: 'Valuation amount', required: false })
  @Expose({ name: 'valuationAmount' })
  @Transform(({ value }) => value ? Number(value) : null)
  valuationAmount?: number;

  @ApiProperty({ description: 'Contribution duration in milliseconds', required: false })
  @Expose({ name: 'contributionDuration' })
  @Transform(({ value }) => value ? Number(value) : null)
  contributionDuration?: number;

  @ApiProperty({ description: 'Investment window duration in milliseconds', required: false })
  @Expose({ name: 'investmentWindowDuration' })
  @Transform(({ value }) => value ? Number(value) : null)
  investmentWindowDuration?: number;

  @ApiProperty({ description: 'Time elapsed duration in milliseconds', required: false })
  @Expose({ name: 'timeElapsedIsEqualToTime' })
  @Transform(({ value }) => value ? Number(value) : null)
  timeElapsedIsEqualToTime?: number;

  @ApiProperty({ description: 'Creation timestamp' })
  @Transform(({ value }) => value ? new Date(value).toISOString() : null)
  createdAt: string;

  @ApiProperty({ description: 'Last update timestamp' })
  @Transform(({ value }) => value ? new Date(value).toISOString() : null)
  updatedAt: string;
}
