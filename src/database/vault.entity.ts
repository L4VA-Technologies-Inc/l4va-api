import { Exclude, Expose, Transform } from 'class-transformer';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  BeforeInsert,
  BeforeUpdate,
  JoinColumn,
  OneToOne,
  OneToMany,
  Check,
  ManyToMany,
  JoinTable,
} from 'typeorm';

import {
  ApplyParamsResult,
  ContributionWindowType,
  InvestmentWindowType,
  SmartContractVaultStatus,
  TerminationType,
  ValueMethod,
  VaultPrivacy,
  VaultStatus,
  VaultType,
} from '../types/vault.types';

import { AcquirerWhitelistEntity } from './acquirerWhitelist.entity';
import { Asset } from './asset.entity';
import { AssetsWhitelistEntity } from './assetsWhitelist.entity';
import { ContributorWhitelistEntity } from './contributorWhitelist.entity';
import { FileEntity } from './file.entity';
import { LinkEntity } from './link.entity';
import { Proposal } from './proposal.entity';
import { Snapshot } from './snapshot.entity';
import { TagEntity } from './tag.entity';
import { TokenRegistry } from './tokenRegistry.entity';
import { User } from './user.entity';

@Entity('vaults')
export class Vault {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({
    type: 'enum',
    enum: VaultType,
    nullable: true,
  })
  type: VaultType;

  @Column({
    type: 'enum',
    enum: VaultPrivacy,
    nullable: true,
  })
  privacy: VaultPrivacy;

  @Column({ nullable: true })
  description?: string;

  @Expose({ name: 'valueMethod' })
  @Column({
    type: 'enum',
    name: 'value_method',
    enum: ValueMethod,
    nullable: true,
  })
  value_method?: ValueMethod;

  @Expose({ name: 'publicationHash' })
  @Column({
    name: 'publication_hash',
    type: 'varchar',
    nullable: true,
  })
  publication_hash: string;

  @Expose({ name: 'contractAddress' })
  @Column({ name: 'contract_address', nullable: true })
  contract_address: string;

  @Expose({ name: 'policyId' })
  @Column({ name: 'policy_id', nullable: true })
  policy_id: string;

  @Expose({ name: 'countView' })
  @Column({ name: 'count_view', type: 'integer', default: 0 })
  count_view: number;

  @Expose({ name: 'assetVaultName' })
  @Column({
    name: 'asset_vault_name',
    type: 'varchar',
    nullable: true,
  })
  asset_vault_name: string;

  @Expose({ name: 'valuationCurrency' })
  @Column({
    name: 'valuation_currency',
    type: 'varchar',
    nullable: true,
  })
  valuation_currency?: string;

  @Expose({ name: 'valuationAmount' })
  @Column({
    name: 'valuation_amount',
    type: 'numeric',
    nullable: true,
  })
  valuation_amount?: number;

  @Expose({ name: 'vtPrice' })
  @Column({
    name: 'vt_price',
    type: 'numeric',
    nullable: true,
  })
  vt_price?: number;

  @Expose({ name: 'contributionOpenWindowType' })
  @Column({
    type: 'enum',
    name: 'contribution_open_window_type',
    enum: ContributionWindowType,
    nullable: true,
  })
  contribution_open_window_type?: ContributionWindowType;

  @Expose({ name: 'contributionOpenWindowTime' })
  @Transform(({ value }) => (value ? new Date(value).getTime() : null))
  @Column({
    name: 'contribution_open_window_time',
    type: 'timestamptz',
    nullable: true,
  })
  contribution_open_window_time?: string;

  @Expose({ name: 'contributionDuration' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'contribution_duration',
    type: 'bigint',
    nullable: true,
  })
  contribution_duration?: number;

  @Expose({ name: 'acquireWindowDuration' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({ name: 'acquire_window_duration', type: 'bigint', nullable: true })
  acquire_window_duration?: number;

  @Expose({ name: 'acquireOpenWindowType' })
  @Column({
    name: 'acquire_open_window_type',
    type: 'enum',
    enum: InvestmentWindowType,
    nullable: true,
  })
  acquire_open_window_type?: InvestmentWindowType;

  @Expose({ name: 'acquireOpenWindowTime' })
  @Transform(({ value }) => (value ? new Date(value).getTime() : null))
  @Column({
    name: 'acquire_open_window_time',
    type: 'timestamptz',
    nullable: true,
  })
  acquire_open_window_time?: string;

  @Expose({ name: 'tokensForAcquires' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'tokens_for_acquires',
    type: 'numeric',
    nullable: true,
  })
  tokens_for_acquires?: number;

  @Expose({ name: 'acquireReserve' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'acquire_reserve',
    type: 'numeric',
    nullable: true,
  })
  acquire_reserve?: number;

  @Expose({ name: 'maxContributeAssets' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'max_contribute_assets',
    type: 'numeric',
    default: 0,
  })
  max_contribute_assets?: number;

  @Expose({ name: 'liquidityPoolContribution' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'liquidity_pool_contribution',
    type: 'numeric',
    nullable: true,
  })
  liquidity_pool_contribution?: number;

  @Expose({ name: 'ftTokenSupply' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({ name: 'ft_token_supply', type: 'numeric', nullable: true })
  ft_token_supply?: number;

  @Expose({ name: 'vaultTokenTicker' })
  @Column({ name: 'vault_token_ticker', nullable: true })
  vault_token_ticker?: string;

  @Expose({ name: 'liquidationHash' })
  @Column({ name: 'liquidation_hash', nullable: true })
  liquidation_hash?: string;

  @Expose({ name: 'ftTokenDecimals' })
  @Column({ name: 'ft_token_decimals', type: 'smallint', default: 1, nullable: true })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Check('"ft_token_decimals" BETWEEN 1 AND 9')
  ft_token_decimals?: number;

  @Expose({ name: 'terminationType' })
  @Column({
    name: 'termination_type',
    type: 'enum',
    enum: TerminationType,
    nullable: true,
  })
  termination_type?: TerminationType;

  @Expose({ name: 'timeElapsedIsEqualToTime' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'time_elapsed_is_equal_to_time',
    type: 'bigint',
    nullable: true,
  })
  time_elapsed_is_equal_to_time?: number;

  @Expose({ name: 'vaultAppreciation' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'vault_appreciation',
    type: 'numeric',
    nullable: true,
  })
  vault_appreciation?: number;

  @Expose({ name: 'creationThreshold' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'creation_threshold',
    type: 'numeric',
    nullable: true,
  })
  creation_threshold?: number;

  @Expose({ name: 'startThreshold' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'start_threshold',
    type: 'numeric',
    nullable: true,
  })
  start_threshold?: number;

  @Expose({ name: 'voteThreshold' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'vote_threshold',
    type: 'numeric',
    nullable: true,
  })
  vote_threshold?: number;

  @Expose({ name: 'executionThreshold' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'execution_threshold',
    type: 'numeric',
    nullable: true,
  })
  execution_threshold?: number;

  @Expose({ name: 'cosigningThreshold' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'cosigning_threshold',
    type: 'numeric',
    nullable: true,
  })
  cosigning_threshold?: number;

  @Expose({ name: 'totalAssetsCostUsd' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'total_assets_cost_usd',
    type: 'numeric',
    nullable: true,
    default: 0,
  })
  total_assets_cost_usd: number;

  @Expose({ name: 'totalAssetsCostAda' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'total_assets_cost_ada',
    type: 'numeric',
    nullable: true,
    default: 0,
  })
  total_assets_cost_ada: number;

  @Expose({ name: 'totalAcquiredValueAda' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'total_acquired_value_ada',
    type: 'numeric',
    nullable: true,
    default: 0,
  })
  total_acquired_value_ada: number;

  @Expose({ name: 'requireReservedCostUsd' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'require_reserved_cost_usd',
    type: 'numeric',
    nullable: true,
    default: 0,
  })
  require_reserved_cost_usd: number;

  @Expose({ name: 'requireReservedCostAda' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'require_reserved_cost_ada',
    type: 'numeric',
    nullable: true,
    default: 0,
  })
  require_reserved_cost_ada: number;

  @Expose({ name: 'fdv' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'fdv',
    type: 'numeric',
    nullable: true,
    default: 0,
  })
  fdv: number;

  @Expose({ name: 'fdvTvl' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'fdv_tvl',
    type: 'numeric',
    nullable: true,
    default: 0,
  })
  fdv_tvl: number;

  @Expose({ name: 'vaultStatus' })
  @Column({
    name: 'vault_status',
    type: 'enum',
    enum: VaultStatus,
    nullable: true,
  })
  vault_status: VaultStatus;

  @Exclude()
  @Column({ name: 'vault_sc_status', type: 'enum', enum: SmartContractVaultStatus, nullable: true })
  vault_sc_status: SmartContractVaultStatus;

  @Expose({ name: 'owner' })
  @ManyToOne(() => User, (owner: User) => owner.id)
  @JoinColumn({ name: 'owner_id' })
  public owner: User;

  @Expose({ name: 'assetsWhitelist' })
  @OneToMany(() => AssetsWhitelistEntity, (asset: AssetsWhitelistEntity) => asset.vault)
  assets_whitelist?: AssetsWhitelistEntity[];

  @Expose({ name: 'acquirerWhitelist' })
  @OneToMany(() => AcquirerWhitelistEntity, (investor: AcquirerWhitelistEntity) => investor.vault)
  acquirer_whitelist?: AcquirerWhitelistEntity[];

  @Expose({ name: 'contributorWhitelist' })
  @OneToMany(() => ContributorWhitelistEntity, (contributor: ContributorWhitelistEntity) => contributor.vault)
  contributor_whitelist?: ContributorWhitelistEntity[];

  @Expose({ name: 'assets' })
  @OneToMany(() => Asset, (asset: Asset) => asset.vault)
  assets?: Asset[];

  @OneToMany(() => Snapshot, snapshot => snapshot.vault)
  snapshots: Snapshot[];

  @OneToMany(() => Proposal, proposal => proposal.vault)
  proposals: Proposal[];

  @OneToMany(() => TokenRegistry, (pr: TokenRegistry) => pr.vault)
  token_registry_prs?: TokenRegistry[];

  @Expose({ name: 'acquireMultiplier' })
  @Column({
    name: 'acquire_multiplier',
    type: 'jsonb',
    nullable: true,
    default: () => 'null',
  })
  acquire_multiplier?: Array<[string, string | null, number]>; // [policyId, assetName?, multiplier]

  @Expose({ name: 'adaDistribution' })
  @Column({
    name: 'ada_distribution',
    type: 'jsonb',
    nullable: true,
    default: () => 'null',
  })
  ada_distribution?: Array<[string, string, number]>; // [policyId, assetName, ada]

  @Expose({ name: 'adaPairMultiplier' })
  @Transform(({ value }) => (value ? Number(value) : null))
  @Column({
    name: 'ada_pair_multiplier',
    type: 'numeric',
    nullable: true,
    default: 1,
  })
  ada_pair_multiplier?: number;

  @Exclude()
  @Column({
    name: 'script_hash',
    type: 'varchar',
    nullable: true,
  })
  script_hash?: string;

  @Exclude()
  @Column({
    name: 'apply_params_result',
    type: 'jsonb',
    nullable: true,
    default: () => 'null',
  })
  apply_params_result?: ApplyParamsResult;

  @Expose({ name: 'lastUpdateTxHash' })
  @Column({
    name: 'last_update_tx_hash',
    type: 'varchar',
    nullable: true,
  })
  last_update_tx_hash?: string;

  @Expose({ name: 'lastUpdateTxIndex' })
  @Column({
    name: 'last_update_tx_index',
    type: 'integer',
    nullable: true,
    default: 0,
  })
  last_update_tx_index?: number;

  @Expose({ name: 'dispatchUtxoTxHash' })
  @Column({
    name: 'dispatch_utxo_tx_hash',
    type: 'varchar',
    nullable: true,
  })
  dispatch_utxo_tx_hash?: string;

  @Expose({ name: 'vaultPolicyId' })
  @Column({
    name: 'vault_policy_id',
    type: 'varchar',
    nullable: true,
  })
  vault_policy_id?: string;

  @Expose({ name: 'vaultImage' })
  @OneToOne(() => FileEntity)
  @JoinColumn({
    name: 'vault_image_id',
  })
  vault_image?: FileEntity;

  @Expose({ name: 'bannerImage' })
  @OneToOne(() => FileEntity)
  @JoinColumn({
    name: 'banner_image_id',
  })
  banner_image?: FileEntity;

  @Expose({ name: 'acquirerWhitelistCsv' })
  @OneToOne(() => FileEntity)
  @JoinColumn({
    name: 'acquirer_whitelist_csv_id',
  })
  acquirer_whitelist_csv?: FileEntity;

  @Expose({ name: 'ftTokenImg' })
  @OneToOne(() => FileEntity)
  @JoinColumn({
    name: 'ft_token_img_id',
  })
  ft_token_img?: FileEntity;

  @Expose({ name: 'socialLinks' })
  @OneToMany(() => LinkEntity, (link: LinkEntity) => link.vault)
  social_links?: LinkEntity[];

  @Expose({ name: 'tags' })
  @ManyToMany(() => TagEntity, (tag: TagEntity) => tag.vaults)
  @JoinTable({
    name: 'vault_tags',
    joinColumn: {
      name: 'vault_id',
      referencedColumnName: 'id',
    },
    inverseJoinColumn: {
      name: 'tag_id',
      referencedColumnName: 'id',
    },
  })
  tags?: TagEntity[];

  @Expose({ name: 'updatedAt' })
  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updated_at: string;

  @Expose({ name: 'createdAt' })
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  created_at: string;

  @Expose({ name: 'contributionPhaseStart' })
  @Column({ name: 'contribution_phase_start', type: 'timestamptz', nullable: true })
  contribution_phase_start?: string;

  @Expose({ name: 'acquirePhaseStart' })
  @Column({ name: 'acquire_phase_start', type: 'timestamptz', nullable: true })
  acquire_phase_start?: string;

  @Expose({ name: 'lockedAt' })
  @Column({ name: 'locked_at', type: 'timestamptz', nullable: true })
  locked_at?: string;

  @Column({ name: 'deleted', type: 'boolean', nullable: false, default: false })
  deleted: boolean;

  @Expose({ name: 'governancePhaseStart' })
  @Column({ name: 'governance_phase_start', type: 'timestamptz', nullable: true })
  governance_phase_start?: string;

  @BeforeInsert()
  setDate() {
    this.created_at = new Date().toISOString();
  }

  @BeforeUpdate()
  updateDate() {
    this.updated_at = new Date().toISOString();
  }
}
