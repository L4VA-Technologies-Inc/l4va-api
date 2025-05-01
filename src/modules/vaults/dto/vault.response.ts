import { ApiProperty } from '@nestjs/swagger';
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
import {User} from "../../../database/user.entity";
import {AssetsWhitelistEntity} from "../../../database/assetsWhitelist.entity";
import {InvestorsWhitelistEntity} from "../../../database/investorsWhitelist.entity";
import {ContributorWhitelistEntity} from "../../../database/contributorWhitelist.entity";
import {Asset} from "../../../database/asset.entity";
import {TagEntity} from "../../../database/tag.entity";
import {DtoRepresent} from "../../../decorators/dto-represents.decorator";

export class VaultShortResponse {
  @ApiProperty({ description: 'Unique identifier of the vault' })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  id: string;

  @ApiProperty({ description: 'Name of the vault' })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  name: string;

  @ApiProperty({ description: 'Description of the vault', required: false })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  description?: string;

  @ApiProperty({ description: 'Tvl', required: false})
  @DtoRepresent({
    transform: ({ value }) => value ? Number(value) : null,
    expose: true
  })
  tvl?: number;


  @ApiProperty({ description: 'Tvl', required: false})
  @DtoRepresent({
    transform: ({ value }) => value ? Number(value) : null,
    expose: true
  })
  baseAllocation?:number;


  @ApiProperty({ description: 'Tvl', required: false})
  @DtoRepresent({
    transform: ({ value }) => value ? Number(value) : null,
    expose: true
  })
  total?: number;


  @ApiProperty({ description: 'Tvl', required: false})
  @DtoRepresent({
    transform: ({ value }) => value ? Number(value) : null,
    expose: true
  })
  invested?: number;

  @ApiProperty({ description: 'Privacy setting of the vault', enum: VaultPrivacy })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  privacy: VaultPrivacy;

  @ApiProperty({ description: 'Timestamp when current phase ends', required: false })
  @DtoRepresent({
    transform: ({ value }) => value ? new Date(value).toISOString() : null,
    expose: true
  })
  phaseEndTime?: string;

  @ApiProperty({ description: 'Time remaining in current phase in milliseconds', required: false })
  @DtoRepresent({
    transform: ({ obj }) => {
      if (!obj.phaseEndTime) return null;
      const now = new Date();
      const endTime = new Date(obj.phaseEndTime);
      const diff = endTime.getTime() - now.getTime();
      return diff > 0 ? diff : 0;
    },
    expose: true
  })
  timeRemaining?: number;

  @ApiProperty({ description: 'Vault image', required: true })
  @DtoRepresent({
    transform: ({ value }) => value ? value.url : null,
    expose: true,
  })
  vaultImage?: FileEntity;

  @ApiProperty({ description: 'Banner image', required:true })
  @DtoRepresent({
    transform: ({ value }) => value ? value.url : null,
    expose: true
  })
  bannerImage?: FileEntity;

  @ApiProperty({ description: 'Status of the vault', enum: VaultStatus })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  vaultStatus: VaultStatus;

  @ApiProperty({ description: 'Social links', type: [LinkEntity], required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'socialLinks'},
  })
  socialLinks?: LinkEntity[];
}

export class VaultFullResponse extends VaultShortResponse {

  @ApiProperty({ description: 'Type of the vault', enum: VaultType })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  type: VaultType;

  @ApiProperty({ description: 'Fractional token image '})
  @DtoRepresent({
    transform: ({ value }) => value ? value.url : null,
    expose: true
  })
  ftTokenImg: FileEntity;

  @ApiProperty({ description: 'Hash of publication tx' })
  @DtoRepresent({
    transform: false,
    expose: { name: 'publicationHash' }
  })
  publicationHash: string;

  @ApiProperty({ description: 'Valuation type', enum: ValuationType, required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'valuationType' }
  })
  valuationType?: ValuationType;

  @ApiProperty({ description: 'Contract address', required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'contractAddress' }
  })
  contractAddress: string;

  @ApiProperty({ description: 'Valuation currency', required: false })
  @DtoRepresent({
    transform: false,
    expose: { name: 'valuationCurrency' }
  })
  valuationCurrency?: string;

  @ApiProperty({ description: 'Valuation amount', required: false })
  @DtoRepresent({
    transform: ({ value }) => value ? Number(value) : null,
    expose: { name: 'valuationAmount' }
  })
  valuationAmount?: number;

  @ApiProperty({ description: 'Contribution duration in milliseconds', required: false })
  @DtoRepresent({
    transform: ({ value }) => value ? Number(value) : null,
    expose: { name: 'contributionDuration' }
  })
  contributionDuration?: number;

  @ApiProperty({ description: 'Investment window duration in milliseconds', required: false })
  @DtoRepresent({
    transform: ({ value }) => value ? Number(value) : null,
    expose: { name: 'investmentWindowDuration' }
  })
  investmentWindowDuration?: number;

  @ApiProperty({ description: 'Time elapsed duration in milliseconds', required: false })
  @DtoRepresent({
    transform: ({ value }) => value ? Number(value) : null,
    expose: { name: 'timeElapsedIsEqualToTime' }
  })
  timeElapsedIsEqualToTime?: number;

  @ApiProperty({ description: 'Contribution window type', enum: ContributionWindowType })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  contributionOpenWindowType: ContributionWindowType;

  @ApiProperty({ description: 'Contribution window time' })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  contributionOpenWindowTime: string;

  @ApiProperty({ description: 'Investment window type', enum: InvestmentWindowType })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  investmentOpenWindowType: InvestmentWindowType;

  @ApiProperty({ description: 'Investment window time' })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  investmentOpenWindowTime: string;

  @ApiProperty({ description: 'Number of assets offered' })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  offAssetsOffered: number;

  @ApiProperty({ description: 'FT investment reserve' })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  ftInvestmentReserve: number;

  @ApiProperty({ description: 'Liquidity pool contribution' })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  liquidityPoolContribution: number;

  @ApiProperty({ description: 'FT token supply' })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  ftTokenSupply: number;

  @ApiProperty({ description: 'FT token ticker' })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  ftTokenTicker: string;

  @ApiProperty({ description: 'FT token decimals' })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  ftTokenDecimals: number;

  @ApiProperty({ description: 'Termination type', enum: TerminationType })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  terminationType: TerminationType;

  @ApiProperty({ description: 'Vault appreciation' })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  vaultAppreciation: number;

  @ApiProperty({ description: 'Vault owner', type: () => User })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  owner: User;

  @ApiProperty({ description: 'Creation threshold', required: false })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  creationThreshold?: number;

  @ApiProperty({ description: 'Start threshold', required: false })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  startThreshold?: number;

  @ApiProperty({ description: 'Vote threshold', required: false })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  voteThreshold?: number;

  @ApiProperty({ description: 'Execution threshold', required: false })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  executionThreshold?: number;

  @ApiProperty({ description: 'Cosigning threshold', required: false })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  cosigningThreshold?: number;

  @ApiProperty({ description: 'Assets whitelist', type: [AssetsWhitelistEntity], required: false })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  assetsWhitelist?: AssetsWhitelistEntity[];

  @ApiProperty({ description: 'Investors whitelist', type: [InvestorsWhitelistEntity], required: false })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  investorsWhitelist?: InvestorsWhitelistEntity[];

  @ApiProperty({ description: 'Contributor whitelist', type: [ContributorWhitelistEntity], required: false })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  contributorWhitelist?: ContributorWhitelistEntity[];

  @ApiProperty({ description: 'Assets', type: [Asset], required: false })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  assets?: Asset[];

  @ApiProperty({ description: 'Investors whitelist CSV file', required: false })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  investorsWhitelistCsv?: FileEntity;

  @ApiProperty({ description: 'Tags', type: [TagEntity], required: false })
  @DtoRepresent({
    transform: false,
    expose: true
  })
  tags?: TagEntity[];

  @ApiProperty({ description: 'Contribution phase start time', required: false })
  @DtoRepresent({
    transform: ({ value }) => value ? new Date(value).toISOString() : null,
    expose: {
      name: 'contributionPhaseStart'
    }
  })
  contributionPhaseStart?: string;

  @ApiProperty({ description: 'Investment phase start time', required: false })
  @DtoRepresent({
    transform: ({ value }) => value ? new Date(value).toISOString() : null,
    expose: true
  })
  investmentPhaseStart?: string;

  @ApiProperty({ description: 'Locked at time', required: false })
  @DtoRepresent({
    transform: ({ value }) => value ? new Date(value).toISOString() : null,
    expose: true
  })
  lockedAt?: string;

  @ApiProperty({ description: 'Creation timestamp' })
  @DtoRepresent({
    transform: ({ value }) => value ? new Date(value).toISOString() : null,
    expose: true
  })
  createdAt: string;

  @ApiProperty({ description: 'Last update timestamp' })
  @DtoRepresent({
    transform: ({ value }) => value ? new Date(value).toISOString() : null,
    expose: true
  })
  updatedAt: string;
}
