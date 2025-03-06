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
import {FileEntity} from "./file.entity";
import {AssetsWhitelistEntity} from "./assetsWhitelist.entity";
import {LinkEntity} from "./link.entity";
import {
  ContributionWindowType,
  InvestmentWindowType, TerminationType,
  ValuationType,
  VaultPrivacy,
  VaultType
} from "../types/vault.types";

@Entity('vaults')
export class Vault {

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({
    type: "enum",
    enum: VaultType,
    nullable: true
  })
  type: VaultType;

  @Column({
    type: "enum",
    enum: VaultPrivacy,
    nullable: true
  })
  privacy: VaultPrivacy;

  @Column({ nullable: true })
  description?: string;

  @Column({
    type: "enum",
    enum: ValuationType,
    nullable: true
  })
  valuation_type?: ValuationType;

  @Column({
    type: "enum",
    enum: ContributionWindowType,
    nullable: true
  })
  contribution_open_window_type?: ContributionWindowType;

  @Column({nullable: true})
  contribution_open_window_time?:string;

  @Column({ type: 'interval', nullable: true})
  asset_window?: string;

  @Column({ type: 'int', nullable: true})
  asset_count_cap_min?:number;

  @Column({ type: 'int', nullable: true})
  asset_count_cap_max?:number;

  @Column({ type: 'interval', nullable: true})
  investment_window_duration?: string;

  @Column({
    type: "enum",
    enum: InvestmentWindowType,
    nullable: true
  })
  investment_open_window_type?: InvestmentWindowType;

  @Column({ type: 'interval', nullable: true})
  investment_open_window_time?: string;

  @Column({ type: "numeric", precision: 5, scale: 2, nullable:true})
  off_assets_offered: string;

  @Column({ type: 'interval', nullable: true})
  ft_investment_window?: string;

  @Column({ type: "numeric", precision: 5, scale: 2,  nullable:true})
  ft_investment_reverse?: string;

  @Column({ type: "numeric", precision: 5, scale: 2, nullable:true })
  liquidity_pool_contribution?: string;

  @Column({ type: "numeric", precision: 5, scale: 2,  nullable:true})
  ft_token_supply?: string;

  @Column({ type: "smallint", default: 1,  nullable:true })
  @Check(`"ft_token_decimals" BETWEEN 1 AND 9`)
  ft_token_decimals?: string;

  @Column({
    type: "enum",
    enum: TerminationType,
    nullable: true
  })
  termination_type?: TerminationType;

  @Column({ type: 'interval', nullable: true})
  time_elapsed_is_equal_to_time?: string;

  @Column({ type: "numeric", precision: 5, scale: 2, nullable:true })
  asset_appreciation?: string;

  @Column({ type: "numeric", precision: 5, scale: 2, nullable:true })
  creation_threshold?: string;
  @Column({ type: "numeric", precision: 5, scale: 2,  nullable:true })
  start_threshold?: string;
  @Column({ type: "numeric", precision: 5, scale: 2,  nullable:true })
  vote_threshold?: string;
  @Column({ type: "numeric", precision: 5, scale: 2,  nullable:true })
  execution_threshold?: string;
  @Column({ type: "numeric", precision: 5, scale: 2,  nullable:true })
  cosigning_threshold?: string;

  @ManyToOne(() => User, (owner: User) => owner.id)
  public owner: User;

  @OneToMany(() => AssetsWhitelistEntity, (asset: AssetsWhitelistEntity) => asset.id)
  assets_whitelist?: AssetsWhitelistEntity[];

  @OneToOne(() => FileEntity)
  @JoinColumn()
  vault_image?: FileEntity;

  @OneToOne(() => FileEntity)
  @JoinColumn()
  banner_image?: FileEntity;

  @OneToOne(() => FileEntity)
  @JoinColumn()
  ft_token_img?: FileEntity;

  @OneToMany(() => LinkEntity, (link: LinkEntity) => link.id)
  social_links?: LinkEntity[]

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updated_at: string;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
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
