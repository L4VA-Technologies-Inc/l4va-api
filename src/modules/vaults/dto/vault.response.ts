import { ApiProperty } from '@nestjs/swagger';
import { Expose, Transform } from 'class-transformer';
import {
  VaultPrivacy,
  VaultStatus,
  VaultType,
  ValuationType,
  ContributionWindowType,
  InvestmentWindowType, TerminationType
} from '../../../types/vault.types';
import { LinkEntity } from '../../../database/link.entity';
import {FileEntity} from "../../../database/file.entity";
import {
  BeforeInsert, BeforeUpdate,
  Check,
  Column,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn
} from "typeorm";
import {User} from "../../../database/user.entity";
import {AssetsWhitelistEntity} from "../../../database/assetsWhitelist.entity";
import {InvestorsWhitelistEntity} from "../../../database/investorsWhitelist.entity";
import {ContributorWhitelistEntity} from "../../../database/contributorWhitelist.entity";
import {Asset} from "../../../database/asset.entity";
import {TagEntity} from "../../../database/tag.entity";

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

  @ApiProperty({ description: 'Timestamp when current phase ends', required: false })
  @Expose()
  @Transform(({ value }) => value ? new Date(value).toISOString() : null)
  phaseEndTime?: string;

  @ApiProperty({ description: 'Time remaining in current phase in milliseconds', required: false })
  @Expose()
  @Transform(({ obj }) => {
    if (!obj.phaseEndTime) return null;
    const now = new Date();
    const endTime = new Date(obj.phaseEndTime);
    const diff = endTime.getTime() - now.getTime();
    return diff > 0 ? diff : 0;
  })
  timeRemaining?: number;

  @ApiProperty({ description: 'Vault image', required: true })
  @Expose()
  @Transform(({ value }) => value ? value.url : null)
  vaultImage?: FileEntity;

  @ApiProperty({ description: 'Banner image', required:true })
  @Transform(({ value }) => value ? value.url : null)
  @Expose()
  bannerImage?: FileEntity;

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

  @ApiProperty({ description: 'Fractional token image '})
  @Expose()
  @Transform(({ value }) => value ? value.url : null)
  ftTokenImg: FileEntity;

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

  @ApiProperty({ description: 'Contribution window type', enum: ContributionWindowType })
  @Expose()
  contributionOpenWindowType: ContributionWindowType;

  @ApiProperty({ description: 'Contribution window time' })
  @Expose()
  contributionOpenWindowTime: string;

  @ApiProperty({ description: 'Investment window type', enum: InvestmentWindowType })
  @Expose()
  investmentOpenWindowType: InvestmentWindowType;

  @ApiProperty({ description: 'Investment window time' })
  @Expose()
  investmentOpenWindowTime: string;

  @ApiProperty({ description: 'Number of assets offered' })
  @Expose()
  offAssetsOffered: number;

  @ApiProperty({ description: 'FT investment reserve' })
  @Expose()
  ftInvestmentReserve: number;

  @ApiProperty({ description: 'Liquidity pool contribution' })
  @Expose()
  liquidityPoolContribution: number;

  @ApiProperty({ description: 'FT token supply' })
  @Expose()
  ftTokenSupply: number;

  @ApiProperty({ description: 'FT token ticker' })
  @Expose()
  ftTokenTicker: string;

  @ApiProperty({ description: 'FT token decimals' })
  @Expose()
  ftTokenDecimals: number;

  @ApiProperty({ description: 'Termination type', enum: TerminationType })
  @Expose()
  terminationType: TerminationType;

  @ApiProperty({ description: 'Vault appreciation' })
  @Expose()
  vaultAppreciation: number;

  @ApiProperty({ description: 'Vault owner', type: () => User })
  @Expose()
  owner: User;

  @ApiProperty({ description: 'Creation threshold', required: false })
  @Expose()
  creation_threshold?: number;

  @ApiProperty({ description: 'Start threshold', required: false })
  @Expose()
  start_threshold?: number;

  @ApiProperty({ description: 'Vote threshold', required: false })
  @Expose()
  vote_threshold?: number;

  @ApiProperty({ description: 'Execution threshold', required: false })
  @Expose()
  execution_threshold?: number;

  @ApiProperty({ description: 'Cosigning threshold', required: false })
  @Expose()
  cosigning_threshold?: number;

  @ApiProperty({ description: 'Assets whitelist', type: [AssetsWhitelistEntity], required: false })
  @Expose()
  assets_whitelist?: AssetsWhitelistEntity[];

  @ApiProperty({ description: 'Investors whitelist', type: [InvestorsWhitelistEntity], required: false })
  @Expose()
  investors_whitelist?: InvestorsWhitelistEntity[];

  @ApiProperty({ description: 'Contributor whitelist', type: [ContributorWhitelistEntity], required: false })
  @Expose()
  contributor_whitelist?: ContributorWhitelistEntity[];

  @ApiProperty({ description: 'Assets', type: [Asset], required: false })
  @Expose()
  assets?: Asset[];

  @ApiProperty({ description: 'Investors whitelist CSV file', required: false })
  @Expose()
  investors_whitelist_csv?: FileEntity;

  @ApiProperty({ description: 'Tags', type: [TagEntity], required: false })
  @Expose()
  tags?: TagEntity[];

  @ApiProperty({ description: 'Contribution phase start time', required: false })
  @Expose()
  @Transform(({ value }) => value ? new Date(value).toISOString() : null)
  contribution_phase_start?: string;

  @ApiProperty({ description: 'Investment phase start time', required: false })
  @Expose()
  @Transform(({ value }) => value ? new Date(value).toISOString() : null)
  investment_phase_start?: string;

  @ApiProperty({ description: 'Locked at time', required: false })
  @Expose()
  @Transform(({ value }) => value ? new Date(value).toISOString() : null)
  locked_at?: string;

  @ApiProperty({ description: 'Creation timestamp' })
  @Transform(({ value }) => value ? new Date(value).toISOString() : null)
  createdAt: string;

  @ApiProperty({ description: 'Last update timestamp' })
  @Transform(({ value }) => value ? new Date(value).toISOString() : null)
  updatedAt: string;
}
