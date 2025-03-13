import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  BeforeInsert,
  BeforeUpdate,
  JoinColumn,
  OneToOne, OneToMany, Check
} from 'typeorm';
import { User } from './user.entity';
import {FileEntity} from './file.entity';
import {AssetsWhitelistEntity} from './assetsWhitelist.entity';
import {LinkEntity} from './link.entity';
import {
  ContributionWindowType,
  InvestmentWindowType, TerminationType,
  ValuationType,
  VaultPrivacy, VaultStatus,
  VaultType
} from '../types/vault.types';
import { Expose } from 'class-transformer';
import {InvestorsWhitelistEntity} from './investorsWhitelist.entity';

@Entity('vaults')
export class Vault {

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({
    type: 'enum',
    enum: VaultType,
    nullable: true
  })
  type: VaultType;

  @Column({
    type: 'enum',
    enum: VaultPrivacy,
    nullable: true
  })
  privacy: VaultPrivacy;

  @Column({ nullable: true })
  description?: string;

  @Expose({ name: 'valuationType'})
  @Column({
    type: 'enum',
    name: 'valuation_type',
    enum: ValuationType,
    nullable: true
  })
  valuation_type?: ValuationType;

  @Expose({ name: 'contributionOpenWindowType'})
  @Column({
    type: 'enum',
    name: 'contribution_open_window_type',
    enum: ContributionWindowType,
    nullable: true
  })
  contribution_open_window_type?: ContributionWindowType;

  @Expose({ name: 'contributionOpenWindowTime'})
  @Column({
    name: 'contribution_open_window_time',
    type: 'timestamptz',
    nullable: true
  })
  contribution_open_window_time?:string;

  @Expose({ name: 'assetWindow'})
  @Column({
    name: 'asset_window',
    type: 'timestamptz', nullable: true})
  asset_window?: string;

  @Expose({ name: 'assetCountCapMin'})
  @Column({
    name: 'asset_count_cap_min',
    type: 'int',
    nullable: true
  })
  asset_count_cap_min?:number;

  @Expose({ name: 'assetCountCapMax'})
  @Column({name: 'asset_count_cap_max', type: 'int', nullable: true})
  asset_count_cap_max?:number;

  @Expose({ name: 'investmentWindowDuration'})
  @Column({name: 'investment_window_duration', type: 'timestamptz', nullable: true})
  investment_window_duration?: string;

  @Expose({ name: 'investmentOpenWindowType'})
  @Column({
    name: 'investment_open_window_type',
    type: 'enum',
    enum: InvestmentWindowType,
    nullable: true
  })
  investment_open_window_type?: InvestmentWindowType;

  @Expose({ name: 'investmentOpenWindowTime'})
  @Column({
    name: 'investment_open_window_time',
    type: 'timestamptz', nullable: true
  })
  investment_open_window_time?: string;

  @Expose({ name: 'offAssetsOffered'})
  @Column({
    name: 'off_assets_offered',
    type: 'numeric', nullable:true})
  off_assets_offered?: number;

  @Expose({ name: 'ftInvestmentWindow'})
  @Column({
    name: 'ft_investment_window',
    type: 'timestamptz', nullable: true})
    ft_investment_window?: string;

  @Expose({ name: 'ftInvestmentReverse'})
  @Column({
    name: 'ft_investment_reverse',
    type: 'numeric', nullable:true})
  ft_investment_reverse?: number;

  @Expose({ name: 'liquidityPoolContribution'})
  @Column({
    name: 'liquidity_pool_contribution',
    type: 'numeric', nullable:true })
  liquidity_pool_contribution?: number;

  @Expose({ name: 'ftTokenSupply'})
  @Column({name: 'ft_token_supply',
    type: 'numeric',  nullable:true})
  ft_token_supply?: number;

  @Expose({ name: 'ftTokenTicker'})
  @Column({name: 'ft_token_ticker', nullable:true})
  ft_token_ticker?: string;

  @Expose({ name: 'ftTokenDecimals'})
  @Column({name: 'ft_token_decimals',
    type: 'smallint', default: 1,  nullable:true })
  @Check('"ft_token_decimals" BETWEEN 1 AND 9')
  ft_token_decimals?: string;

  @Expose({ name: 'terminationType'})
  @Column({
    name: 'termination_type',
    type: 'enum',
    enum: TerminationType,
    nullable: true
  })
  termination_type?: TerminationType;

  @Expose({ name: 'timeElapsedIsEqualToTime'})
  @Column({
    name: 'time_elapsed_is_equal_to_time',
    type: 'timestamptz', nullable: true})
  time_elapsed_is_equal_to_time?: string;

  @Expose({ name: 'assetAppreciation'})
  @Column({
    name: 'asset_appreciation',
    type: 'numeric',
    nullable:true })
  asset_appreciation?: number;

  @Expose({ name: 'creationThreshold' })
  @Column({
    name: 'creation_threshold',
    type: 'numeric',
    nullable: true,
  })
  creation_threshold?: number;

  @Expose({ name: 'startThreshold' })
  @Column({
    name: 'start_threshold',
    type: 'numeric',
    nullable: true,
  })
  start_threshold?: number;

  @Expose({ name: 'voteThreshold' })
  @Column({
    name: 'vote_threshold',
    type: 'numeric',
    nullable: true,
  })
  vote_threshold?: number;

  @Expose({ name: 'executionThreshold' })
  @Column({
    name: 'execution_threshold',
    type: 'numeric',
    nullable: true,
  })
  execution_threshold?: number;

  @Expose({ name: 'cosigningThreshold' })
  @Column({
    name: 'cosigning_threshold',
    type: 'numeric',
    nullable: true,
  })
  cosigning_threshold?: number;

  @Expose({ name: 'vaultStatus'})
  @Column({
    name: 'vault_status',
    type: 'enum',
    enum: VaultStatus,
    nullable: true
  })
  vault_status: VaultStatus;

  @Expose({ name: 'owner' })
  @ManyToOne(() => User, (owner: User) => owner.id)
  @JoinColumn({ name: 'owner_id' })
  public owner: User;

  @Expose({ name: 'assetsWhitelist' })
  @OneToMany(() => AssetsWhitelistEntity, (asset: AssetsWhitelistEntity) => asset.vault)
  assets_whitelist?: AssetsWhitelistEntity[];

  @Expose({ name: 'investorsWhitelist' })
  @OneToMany(() => InvestorsWhitelistEntity, (investor: InvestorsWhitelistEntity) => investor.vault)
  investors_whitelist?: InvestorsWhitelistEntity[];

  @Expose({ name: 'vaultImage' })
  @OneToOne(() => FileEntity)
  @JoinColumn({
    name: 'vault_image_id'
  })
  vault_image?: FileEntity;

  @Expose({ name: 'bannerImage' })
  @OneToOne(() => FileEntity)
  @JoinColumn({
    name: 'banner_image_id'
  })
  banner_image?: FileEntity;

  @Expose({ name: 'assetsWhitelistCsv'})
  @OneToOne(() => FileEntity)
  @JoinColumn({
    name: 'assets_whitelist_csv_id'
  })
  assets_whitelist_csv?: FileEntity;

  @Expose({ name: 'investorsWhitelistCsv'})
  @OneToOne(() => FileEntity)
  @JoinColumn({
    name: 'investors_whitelist_csv_id'
  })
  investors_whitelist_csv?: FileEntity;

  @Expose({ name: 'ftTokenImg' })
  @OneToOne(() => FileEntity)
  @JoinColumn({
    name: 'ft_token_img_id'
  })
  ft_token_img?: FileEntity;

  @Expose({ name: 'socialLinks' })
  @OneToMany(() => LinkEntity, (link: LinkEntity) => link.vault)
  social_links?: LinkEntity[];

  @Expose({ name: 'updatedAt' })
  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updated_at: string;

  @Expose({ name: 'createdAt' })
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  created_at: string;

  @BeforeInsert()
  setDate() {
    this.created_at = new Date().toISOString();
  }

  @BeforeUpdate()
  updateDate() {
    this.updated_at = new Date().toISOString();
  }
}
