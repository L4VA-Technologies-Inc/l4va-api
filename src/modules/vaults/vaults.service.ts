import { Credential, EnterpriseAddress, ScriptHash } from '@emurgo/cardano-serialization-lib-nodejs';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { instanceToPlain, plainToInstance } from 'class-transformer';
import * as csv from 'csv-parse';
import { Brackets, In, Not, Repository, UpdateResult } from 'typeorm';

import { AwsService } from '../aws_bucket/aws.service';
import { TaptoolsService } from '../taptools/taptools.service';

import { CreateVaultReq } from './dto/createVault.req';
import { VaultStatisticsResponse } from './dto/get-vaults-statistics.dto';
import { DateRangeDto, SortOrder, TVLCurrency, VaultFilter, VaultSortField } from './dto/get-vaults.dto';
import { PaginatedResponseDto } from './dto/paginated-response.dto';
import { PublishVaultDto } from './dto/publish-vault.dto';
import { VaultAcquireResponse, VaultFullResponse, VaultShortResponse } from './dto/vault.response';
import { GovernanceService } from './phase-management/governance/governance.service';
import { TransactionsService } from './processing-tx/offchain-tx/transactions.service';
import { BlockchainScannerService } from './processing-tx/onchain/blockchain-scanner.service';
import { BlockchainService } from './processing-tx/onchain/blockchain.service';
import { VaultValidationException } from './processing-tx/onchain/exceptions/vault-validation.exception';
import { valuation_sc_type, vault_sc_privacy } from './processing-tx/onchain/types/vault-sc-type';
import { VaultManagingService } from './processing-tx/onchain/vault-managing.service';

import { AcquirerWhitelistEntity } from '@/database/acquirerWhitelist.entity';
import { Asset } from '@/database/asset.entity';
import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { ContributorWhitelistEntity } from '@/database/contributorWhitelist.entity';
import { FileEntity } from '@/database/file.entity';
import { LinkEntity } from '@/database/link.entity';
import { TagEntity } from '@/database/tag.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { transformToSnakeCase } from '@/helpers';
import { AssetOriginType, AssetStatus, AssetType } from '@/types/asset.types';
import { ProposalStatus } from '@/types/proposal.types';
import { TransactionStatus, TransactionType } from '@/types/transaction.types';
import {
  ContributionWindowType,
  InvestmentWindowType,
  ValueMethod,
  VaultPrivacy,
  VaultStatus,
} from '@/types/vault.types';

/**
 * VaultsService
 *
 * This service manages the creation, publishing, updating, and retrieval of vaults in the system.
 * It handles business logic for vault lifecycle, including draft and published states, asset and whitelist management,
 * CSV parsing, transaction confirmation, and integration with AWS S3, blockchain, and related services.
 *
 * Main responsibilities:
 * - Creating and saving new vaults (draft and published)
 * - Managing vault assets, whitelists, tags, and images
 * - Handling vault publishing and transaction confirmation
 * - Providing paginated and filtered vault listings for users
 * - Supporting vault burning (liquidation) operations
 * - Integrating with AWS S3 for CSV parsing and file management
 * - Integrating with blockchain services for on-chain operations
 */
@Injectable()
export class VaultsService {
  private readonly logger = new Logger(VaultsService.name);
  private readonly MAX_RETRIES = 10;
  private readonly INITIAL_RETRY_DELAY = 3000; // 3 seconds

  constructor(
    @InjectRepository(Vault)
    private readonly vaultsRepository: Repository<Vault>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(LinkEntity)
    private readonly linksRepository: Repository<LinkEntity>,
    @InjectRepository(FileEntity)
    private readonly filesRepository: Repository<FileEntity>,
    @InjectRepository(AssetsWhitelistEntity)
    private readonly assetsWhitelistRepository: Repository<AssetsWhitelistEntity>,
    @InjectRepository(AcquirerWhitelistEntity)
    private readonly acquirerWhitelistRepository: Repository<AcquirerWhitelistEntity>,
    @InjectRepository(TagEntity)
    private readonly tagsRepository: Repository<TagEntity>,
    @InjectRepository(ContributorWhitelistEntity)
    private readonly contributorWhitelistRepository: Repository<ContributorWhitelistEntity>,
    @InjectRepository(Asset)
    private readonly assetsRepository: Repository<Asset>,
    private readonly awsService: AwsService,
    private readonly vaultContractService: VaultManagingService,
    private readonly blockchainScannerService: BlockchainScannerService,
    private readonly blockchainService: BlockchainService,
    private readonly governanceService: GovernanceService,
    private readonly taptoolsService: TaptoolsService,
    private readonly transactionsService: TransactionsService
  ) {}

  /**
   * Waits asynchronously for a specified number of milliseconds.
   * @param ms - Milliseconds to wait
   */
  private async wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Confirms and processes a blockchain transaction for a vault, with retry logic and exponential backoff.
   * Updates the vault's contract address upon success.
   * @param txHash - Transaction hash
   * @param vault - Vault entity
   * @param attempt - Current retry attempt
   */
  private async confirmAndProcessTransaction(txHash: string, vault: Vault, attempt = 0): Promise<void> {
    try {
      await this.wait(12000); // Initial wait before first attempt

      const txDetail = await this.blockchainScannerService.getTransactionDetails(txHash);

      if (!txDetail || !txDetail.output_amount || txDetail.output_amount.length < 2) {
        throw new Error('Transaction output not found or invalid format');
      }

      const POLICY_ID = vault.script_hash;
      const SC_ADDRESS = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(POLICY_ID)))
        .to_address()
        .to_bech32();

      const updateResult = await this.vaultsRepository.update({ id: vault.id }, { contract_address: SC_ADDRESS });

      if (updateResult.affected === 0) {
        this.logger.error(`Vault ${vault.id} not found during transaction confirmation`);
        return;
      }

      this.logger.log(`Successfully processed transaction ${txHash} for vault ${vault.id}`);
    } catch (error) {
      if (attempt >= this.MAX_RETRIES - 1) {
        this.logger.error(`Max retries reached for transaction ${txHash}:`, error);
        return;
      }

      // Exponential backoff: 3s, 6s, 12s, 24s, etc.
      const delay = this.INITIAL_RETRY_DELAY * Math.pow(2, attempt);
      this.logger.log(`Retrying confirm vault ${vault.id} tx in ${delay}ms...`);

      await this.wait(delay);
      return this.confirmAndProcessTransaction(txHash, vault, attempt + 1);
    }
  }

  /**
   * Parses a CSV file from AWS S3 and extracts valid Cardano addresses.
   * @param file_key - S3 file key
   * @returns Array of valid Cardano addresses
   */
  private async parseCSVFromS3(file_key: string): Promise<string[]> {
    try {
      const csvStream = await this.awsService.getCsv(file_key);
      const csvData = await csvStream.data.toArray();
      const csvString = Buffer.concat(csvData).toString();

      return new Promise((resolve, reject) => {
        const results: string[] = [];
        csv
          .parse(csvString, {
            columns: false,
            skip_empty_lines: true,
            trim: true,
          })
          .on('data', data => {
            const address = data[0];
            if (address && typeof address === 'string' && /^addr1[a-zA-Z0-9]{98}$/.test(address)) {
              results.push(address);
            }
          })
          .on('end', () => resolve(results))
          .on('error', error => reject(error));
      });
    } catch (error) {
      console.error('Error parsing CSV from S3:', error);
      throw new BadRequestException('Failed to parse CSV file from S3');
    }
  }

  /**
   * Creates a new vault for the specified user with the provided data.
   * Handles validation, file processing, whitelist and tag management, and on-chain transaction creation.
   * Returns the vault ID and a presigned transaction for on-chain publishing.
   *
   * Steps performed:
   * - Validates user and vault parameters
   * - Processes images, whitelists, and tags
   * - Saves the vault and related entities to the database
   * - Prepares on-chain transaction and returns presignedTx
   *
   * @param userId - ID of the vault owner
   * @param data - Vault creation request data (CreateVaultReq)
   * @returns Object containing vaultId and presignedTx
   * @throws UnauthorizedException if user is not found
   * @throws BadRequestException for invalid input or failed creation
   */
  async createVault(
    userId: string,
    data: CreateVaultReq
  ): Promise<{
    vaultId: string;
    presignedTx: string;
  }> {
    try {
      const owner = await this.usersRepository.findOne({
        where: { id: userId },
      });

      if (!owner) {
        throw new UnauthorizedException('User was not authorized!');
      }

      // Validate valuation type based on privacy setting
      if (data.privacy === VaultPrivacy.public && data.valueMethod !== ValueMethod.lbe) {
        throw new BadRequestException('Public vaults can only use LBE valuation type');
      }
      if (
        (data.privacy === VaultPrivacy.private || data.privacy === VaultPrivacy.semiPrivate) &&
        ![ValueMethod.lbe, ValueMethod.fixed].includes(data.valueMethod)
      ) {
        throw new BadRequestException('Private and semi-private vaults can use either LBE or fixed valuation type');
      }

      // Validate required fields for fixed valuation type
      if (data.valueMethod === ValueMethod.fixed) {
        if (!data.valuationCurrency) {
          throw new BadRequestException('Valuation currency is required when using fixed valuation type');
        }
        if (!data.valuationAmount) {
          throw new BadRequestException('Valuation amount is required when using fixed valuation type');
        }
      }

      // Validate whether ticker is already used in active vaults (Published, Contribution, Acquire, Locked)
      if (data.vaultTokenTicker) {
        const existingVaultWithTicker = await this.vaultsRepository.exists({
          where: {
            vault_token_ticker: data.vaultTokenTicker,
            vault_status: In([
              VaultStatus.published,
              VaultStatus.contribution,
              VaultStatus.acquire,
              VaultStatus.locked,
            ]),
          },
        });
        if (existingVaultWithTicker) {
          throw new BadRequestException('Ticker is already in use by another active vault');
        }
      }

      // Process image files - allow reuse of existing files
      const imgKey = data.vaultImage?.split('image/')[1];
      let vaultImg = null;
      if (imgKey) {
        // Create a new file record that points to the same S3 object
        vaultImg = await this.awsService.createFileRecordForVault(imgKey);
        this.logger.log(`Created new file record for vault image: ${imgKey}`);
      }

      // Same for FT token image
      const ftTokenImgKey = data.ftTokenImg?.split('image/')[1];
      let ftTokenImg = null;
      if (ftTokenImgKey) {
        ftTokenImg = await this.awsService.createFileRecordForVault(ftTokenImgKey);
        this.logger.log(`Created new file record for FT token image: ${ftTokenImgKey}`);
      }

      // Same for whitelist CSVs
      const acquirerWhitelistCsvKey = data.acquirerWhitelistCsv?.key;
      let acquirerWhitelistFile = null;
      if (acquirerWhitelistCsvKey) {
        acquirerWhitelistFile = await this.awsService.createFileRecordForVault(acquirerWhitelistCsvKey);
        this.logger.log(`Created new file record for acquirer whitelist: ${acquirerWhitelistCsvKey}`);
      }

      const contributorWhitelistCsvKey = data.contributorWhitelistCsv?.split('csv/')[1];
      const contributorWhitelistFile = contributorWhitelistCsvKey
        ? await this.filesRepository.findOne({
            where: { file_key: contributorWhitelistCsvKey },
          })
        : null;

      const contributionOpenWindowTime = data.contributionOpenWindowTime
        ? new Date(data.contributionOpenWindowTime).toISOString()
        : null;
      const acquireOpenWindowTime = data.acquireOpenWindowTime
        ? new Date(data.acquireOpenWindowTime).toISOString()
        : null;

      // Prepare vault data
      const vaultData = transformToSnakeCase({
        ...data,
        owner: owner,
        contributionDuration: data.contributionDuration,
        acquireWindowDuration: data.acquireWindowDuration,
        acquireOpenWindowTime,
        contributionOpenWindowTime,
        timeElapsedIsEqualToTime: data.timeElapsedIsEqualToTime,
        vaultStatus: VaultStatus.created,
        vaultImage: vaultImg,
        ftTokenImg: ftTokenImg,
        acquirerWhitelistCsv: acquirerWhitelistFile,
        contributorWhitelistCsv: contributorWhitelistFile,
      });

      delete vaultData.assets_whitelist;
      delete vaultData.acquirer_whitelist;
      delete vaultData.contributor_whitelist;
      delete vaultData.tags;

      let newVault: Vault;
      try {
        newVault = await this.vaultsRepository.save(vaultData as Vault);
        // Always reload the entity to ensure it's managed and has all relations
        newVault = await this.vaultsRepository.findOne({ where: { id: newVault.id } });
      } catch (error) {
        // Handle unique constraint violation for file relations as fallback
        if (error.code === '23505' && error.detail?.includes('already exists')) {
          this.logger.warn(
            'Duplicate key constraint violation during vault creation, retrying without file relations:',
            error.detail
          );

          // Remove file relations and retry
          const vaultDataWithoutFiles = { ...vaultData };
          delete vaultDataWithoutFiles.vaultImage;
          delete vaultDataWithoutFiles.ftTokenImg;
          delete vaultDataWithoutFiles.acquirerWhitelistCsv;
          delete vaultDataWithoutFiles.contributorWhitelistCsv;

          try {
            newVault = await this.vaultsRepository.save(vaultDataWithoutFiles as Vault);
            this.logger.log('Vault creation succeeded without file relations');
          } catch (retryError) {
            this.logger.error('Vault creation failed even without file relations:', retryError);
            throw new BadRequestException('Failed to create vault due to file conflicts. Please try again.');
          }
        } else {
          throw error;
        }
      }

      // Handle social links
      if (data.socialLinks?.length > 0) {
        const links = data.socialLinks.map(linkItem => {
          return this.linksRepository.create({
            vault: newVault,
            name: linkItem.name,
            url: linkItem.url,
          });
        });
        await this.linksRepository.save(links);
      }

      // Handle assets whitelist
      // TODO: Add lovelace support
      let maxCountOf = 0;

      // Then process them
      const uniquePolicyIds = Array.from(new Map(data.assetsWhitelist.map(obj => [obj.policyId, obj])).values());

      await Promise.all(
        uniquePolicyIds.map(async assetItem => {
          if (!assetItem.policyId) return;

          const result = await this.assetsWhitelistRepository
            .createQueryBuilder()
            .insert()
            .values({
              vault: newVault,
              policy_id: assetItem.policyId,
              asset_count_cap_min: assetItem.countCapMin,
              asset_count_cap_max: assetItem.countCapMax,
            })
            .orIgnore()
            .execute();

          if (result.identifiers.length > 0 && assetItem.countCapMax) {
            maxCountOf += assetItem.countCapMax;
          }
        })
      );

      newVault.max_contribute_assets = Number(maxCountOf) || 0;
      await this.vaultsRepository.save(newVault);
      // Handle acquirer whitelist
      const acquirerFromCsv = acquirerWhitelistFile ? await this.parseCSVFromS3(acquirerWhitelistFile.file_key) : [];

      const acquirer = data.acquirerWhitelist ? [...data.acquirerWhitelist.map(item => item.walletAddress)] : [];

      const allAcquirer = new Set([...acquirer, ...acquirerFromCsv]);

      await Promise.all(
        Array.from(allAcquirer).map(walletAddress => {
          return this.acquirerWhitelistRepository.save({
            vault: newVault,
            wallet_address: walletAddress,
          });
        })
      );

      // Handle contributors whitelist
      const contributorsFromCsv = contributorWhitelistFile
        ? await this.parseCSVFromS3(contributorWhitelistFile.file_key)
        : [];

      const contributorList = data.contributorWhitelist
        ? [...(data.contributorWhitelist.map(item => item.walletAddress) || [])]
        : [];

      const allContributors = new Set([...contributorList, ...contributorsFromCsv]);
      const contributorsArray = [...allContributors];

      contributorsArray.map(item => {
        return this.contributorWhitelistRepository.save({
          vault: newVault,
          wallet_address: item,
        });
      });

      // this.eventEmitter.emit('vault.whitelist_added', {
      //   vaultId: newVault.id,
      //   vaultName: newVault.name,
      //   userIds: [],
      // });

      // Handle tags
      if (data.tags?.length > 0) {
        const tags = await Promise.all(
          data.tags.map(async tagName => {
            let tag = await this.tagsRepository.findOne({
              where: { name: tagName },
            });
            if (!tag) {
              tag = await this.tagsRepository.save({
                name: tagName,
              });
            }
            return tag;
          })
        );
        newVault.tags = tags;
        await this.vaultsRepository.save(newVault);
      }

      const finalVault = await this.vaultsRepository.findOne({
        where: { id: newVault.id },
        relations: [
          'owner',
          'social_links',
          'assets_whitelist',
          'acquirer_whitelist',
          'contributor_whitelist',
          'tags',
          'vault_image',
          'banner_image',
          'ft_token_img',
        ],
      });

      if (!finalVault) {
        throw new BadRequestException('Failed to retrieve created vault');
      }

      const policyWhitelist = [...new Set(finalVault?.assets_whitelist.map(item => item.policy_id))];
      const contributorWhitelist = [...new Set(finalVault?.contributor_whitelist.map(item => item.wallet_address))];

      const privacy = vault_sc_privacy[finalVault.privacy as VaultPrivacy];
      const valueMethod = valuation_sc_type[finalVault.value_method as ValueMethod];

      // Calculate start time based on contribution window type
      let startTime: number;
      if (finalVault.contribution_open_window_type === ContributionWindowType.uponVaultLaunch) {
        startTime = new Date().getTime();
      } else if (
        finalVault.contribution_open_window_type === ContributionWindowType.custom &&
        finalVault.contribution_open_window_time
      ) {
        // contribution_open_window_time is already in milliseconds due to @Transform in entity
        startTime = Number(finalVault.contribution_open_window_time);
      } else {
        throw new BadRequestException('Invalid contribution window configuration');
      }

      const assetWindow = {
        start: startTime,
        end: startTime + Number(finalVault.contribution_duration),
      };

      // Calculate acquire window start time
      let acquireStartTime: number;
      if (finalVault.acquire_open_window_type === InvestmentWindowType.uponAssetWindowClosing) {
        acquireStartTime = assetWindow.end;
      } else if (
        finalVault.acquire_open_window_type === InvestmentWindowType.custom &&
        finalVault.acquire_open_window_time
      ) {
        // acquire_open_window_time is already in milliseconds due to @Transform in entity
        acquireStartTime = Number(finalVault.acquire_open_window_time);
      } else {
        throw new BadRequestException('Invalid acquire window configuration');
      }

      const acquireWindow = {
        start: acquireStartTime,
        end: acquireStartTime + Number(finalVault.acquire_window_duration),
      };

      const { presignedTx, contractAddress, vaultAssetName, scriptHash, applyParamsResult } =
        await this.vaultContractService.createOnChainVaultTx({
          vaultName: finalVault.name,
          customerAddress: finalVault.owner.address,
          vaultId: finalVault.id,
          allowedPolicies: policyWhitelist,
          allowedContributors: contributorWhitelist,
          contractType: privacy,
          valueMethod: valueMethod,
          assetWindow,
          acquireWindow,
        });

      finalVault.contract_address = contractAddress;
      finalVault.asset_vault_name = vaultAssetName;
      finalVault.script_hash = scriptHash;
      finalVault.apply_params_result = applyParamsResult;
      finalVault.ft_token_decimals = this.calculateOptimalDecimals(finalVault.ft_token_supply || 1_000_000);

      await this.vaultsRepository.save(finalVault);

      return {
        vaultId: finalVault.id,
        presignedTx,
      };
    } catch (error) {
      this.logger.error('Error creating vault:', error);

      // If it's already a BadRequestException, re-throw it
      if (error instanceof BadRequestException || error instanceof VaultValidationException) {
        throw error;
      }

      // Handle database constraint violations as fallback
      if (error.code === '23505') {
        if (error.detail?.includes('vault_image_id')) {
          throw new BadRequestException(
            'The selected vault image is already in use. The vault was created without the image.'
          );
        }
        if (error.detail?.includes('ft_token_img_id')) {
          throw new BadRequestException(
            'The selected FT token image is already in use. The vault was created without the image.'
          );
        }
        if (error.detail?.includes('acquirer_whitelist_csv_id')) {
          throw new BadRequestException(
            'The selected acquirer whitelist CSV is already in use. The vault was created without the CSV file.'
          );
        }
        throw new BadRequestException(
          'Some files you selected are already in use. The vault was created without those files.'
        );
      }

      throw new BadRequestException('Failed to create vault. Please check your input and try again.');
    }
  }

  /**
   * Retrieves statistics about vaults for the landing page.
   *
   * @returns Object containing platform statistics
   */
  async getVaultStatistics(): Promise<VaultStatisticsResponse> {
    try {
      // Count active vaults (published, contribution, acquire, locked)
      const activeVaultsCount = await this.vaultsRepository.count({
        where: {
          vault_status: In([VaultStatus.contribution, VaultStatus.acquire, VaultStatus.locked]),
          deleted: false,
        },
      });

      const totalVaultsCount = await this.vaultsRepository.count({
        where: {
          vault_status: In([VaultStatus.published, VaultStatus.contribution, VaultStatus.acquire, VaultStatus.locked]),
        },
      });
      // Get sum of total assets value for locked vaults only
      const totalValueQuery = await this.vaultsRepository
        .createQueryBuilder('vault')
        .select('SUM(vault.total_assets_cost_usd)', 'totalValueUsd')
        .addSelect('SUM(vault.total_assets_cost_ada)', 'totalValueAda')
        .where('vault.vault_status = :status', { status: VaultStatus.locked })
        .andWhere('vault.deleted = :deleted', { deleted: false })
        .getRawOne();

      // Count total assets contributed across all vaults
      const totalContributedQuery = await this.vaultsRepository
        .createQueryBuilder('vault')
        .select('SUM(vault.total_assets_cost_usd)', 'totalValueUsd')
        .addSelect('SUM(vault.total_assets_cost_ada)', 'totalValueAda')
        .where('vault.vault_status IN (:...statuses)', {
          statuses: [VaultStatus.contribution, VaultStatus.acquire, VaultStatus.locked, VaultStatus.failed],
        })
        .andWhere('vault.deleted = :deleted', { deleted: false })
        .getRawOne();

      // Count total assets ever contributed (all time, including removed)
      const totalAssetsQuery = await this.assetsRepository
        .createQueryBuilder('asset')
        .select('COUNT(asset.id)', 'count')
        .getRawOne();

      // Get total acquired value (both ADA and USD) across all vaults
      const totalAcquiredQuery = await this.vaultsRepository
        .createQueryBuilder('vault')
        .select('SUM(vault.total_acquired_value_ada)', 'totalAcquiredAda')
        .getRawOne();

      const vaultsByStage = await this.getVaultsByStageData();
      const vaultsByType = await this.getVaultsByTypeData();

      const adaPrice = await this.taptoolsService.getAdaPrice();

      const statistics = {
        activeVaults: activeVaultsCount,
        totalVaults: totalVaultsCount,
        totalValueUsd: Number(totalValueQuery?.totalValueUsd || 0),
        totalValueAda: Number(totalValueQuery?.totalValueAda || 0),
        totalContributedUsd: Number(totalContributedQuery?.totalValueUsd || 0),
        totalContributedAda: Number(totalContributedQuery?.totalValueAda || 0),
        totalAssets: Number(totalAssetsQuery?.count || 0),
        totalAcquiredAda: Number(totalAcquiredQuery?.totalAcquiredAda || 0),
        totalAcquiredUsd: parseFloat((Number(totalAcquiredQuery?.totalAcquiredAda || 0) * adaPrice).toFixed(2)),
        vaultsByStage,
        vaultsByType,
      };

      return plainToInstance(VaultStatisticsResponse, statistics, {
        excludeExtraneousValues: true,
      });
    } catch (error) {
      this.logger.error('Error retrieving vault statistics:', error);
      throw new InternalServerErrorException('Failed to retrieve vault statistics');
    }
  }

  /**
   * Gets distribution of vaults by stage with TVL in both ADA and USD
   * @returns Record of stages with percentages and TVL values
   */
  private async getVaultsByStageData(): Promise<
    Record<string, { percentage: number; valueAda: string; valueUsd: string }>
  > {
    try {
      // Get TVL by vault status for both currencies
      const statusResults = await this.vaultsRepository
        .createQueryBuilder('vault')
        .select('vault.vault_status', 'status')
        .addSelect('SUM(vault.total_assets_cost_ada)', 'valueAda')
        .addSelect('SUM(vault.total_assets_cost_usd)', 'valueUsd')
        .addSelect('COUNT(vault.id)', 'count')
        .where('vault.deleted = :deleted', { deleted: false })
        .andWhere('vault.vault_status IN (:...statuses)', {
          statuses: ['contribution', 'acquire', 'locked', 'burned'],
        })
        .groupBy('vault.vault_status')
        .getRawMany();

      // Calculate total ADA value for percentages
      const totalValueAda = statusResults.reduce((sum, item) => sum + Number(item.valueAda || 0), 0);

      const result = {
        contribution: { percentage: 0, valueAda: '0', valueUsd: '0' },
        acquire: { percentage: 0, valueAda: '0', valueUsd: '0' },
        locked: { percentage: 0, valueAda: '0', valueUsd: '0' },
        terminated: { percentage: 0, valueAda: '0', valueUsd: '0' },
      };

      const statusMap = {
        contribution: 'contribution',
        acquire: 'acquire',
        locked: 'locked',
        burned: 'terminated',
      };

      statusResults.forEach(item => {
        const status = statusMap[item.status] || item.status;
        const valueAda = Number(item.valueAda || 0);
        const valueUsd = Number(item.valueUsd || 0);
        const percentage = totalValueAda > 0 ? (valueAda / totalValueAda) * 100 : 0;

        result[status.toLowerCase()] = {
          percentage: parseFloat(percentage.toFixed(2)),
          valueAda,
          valueUsd,
        };
      });

      return result;
    } catch (error) {
      this.logger.error('Error calculating vaults by stage:', error);
      // Return default object with zero values for all required statuses
      return {
        contribution: { percentage: 0, valueAda: '0', valueUsd: '0' },
        acquire: { percentage: 0, valueAda: '0', valueUsd: '0' },
        locked: { percentage: 0, valueAda: '0', valueUsd: '0' },
        terminated: { percentage: 0, valueAda: '0', valueUsd: '0' },
      };
    }
  }

  /**
   * Gets distribution of vaults by privacy type with TVL in both ADA and USD
   * @returns Record of privacy types with percentages and TVL values
   */
  private async getVaultsByTypeData(): Promise<
    Record<string, { percentage: number; valueAda: number; valueUsd: number }>
  > {
    try {
      const privacyResults = await this.vaultsRepository
        .createQueryBuilder('vault')
        .select('vault.privacy', 'type')
        .addSelect('SUM(vault.total_assets_cost_ada)', 'valueAda')
        .addSelect('SUM(vault.total_assets_cost_usd)', 'valueUsd')
        .addSelect('COUNT(vault.id)', 'count')
        .where('vault.deleted = :deleted', { deleted: false })
        .groupBy('vault.privacy')
        .getRawMany();

      const totalValueAda = privacyResults.reduce((sum, item) => sum + Number(item.valueAda || 0), 0);

      const result = {
        private: {
          percentage: 0,
          valueAda: 0,
          valueUsd: 0,
        },
        public: {
          percentage: 0,
          valueAda: 0,
          valueUsd: 0,
        },
        semiPrivate: {
          percentage: 0,
          valueAda: 0,
          valueUsd: 0,
        },
      };

      privacyResults.forEach(item => {
        if (item.type) {
          const type = item.type;
          const valueAda = Number(item.valueAda || 0);
          const valueUsd = Number(item.valueUsd || 0);
          const percentage = parseFloat((totalValueAda > 0 ? (valueAda / totalValueAda) * 100 : 0).toFixed(2)) || 0;

          const key = type === 'semi-private' ? 'semiPrivate' : type.toLowerCase();
          result[key] = {
            percentage,
            valueAda,
            valueUsd,
          };
        }
      });

      return result;
    } catch (error) {
      this.logger.error('Error calculating vaults by type:', error);
      return {
        private: { percentage: 0, valueAda: 0, valueUsd: 0 },
        public: { percentage: 0, valueAda: 0, valueUsd: 0 },
        semiPrivate: { percentage: 0, valueAda: 0, valueUsd: 0 },
      };
    }
  }

  /**
   * Publishes a vault by submitting a signed transaction and updating vault status.
   * Starts transaction confirmation in the background.
   * @param userId - ID of the vault owner
   * @param signedTx - Signed transaction object
   * @returns Full vault response
   */
  async publishVault(userId: string, signedTx): Promise<VaultFullResponse> {
    const vault = await this.vaultsRepository.findOne({
      where: {
        id: signedTx.vaultId,
      },
      relations: ['owner'],
    });
    if (vault.owner.id !== userId) {
      throw new UnauthorizedException('You must be an owner of vault!');
    }

    const publishedTx = await this.vaultContractService.submitOnChainVaultTx(
      signedTx,
      vault.asset_vault_name,
      vault.script_hash,
      vault.apply_params_result
    );
    vault.vault_status = VaultStatus.published;
    vault.publication_hash = publishedTx.txHash;
    await this.vaultsRepository.save(vault);

    await this.usersRepository.increment({ id: vault.owner.id }, 'total_vaults', 1);

    // Start transaction confirmation process in background
    this.confirmAndProcessTransaction(publishedTx.txHash, vault).catch(error => {
      this.logger.error(`Failed to process transaction ${publishedTx.txHash}:`, error);
    });

    return plainToInstance(VaultFullResponse, instanceToPlain(vault), { excludeExtraneousValues: true });
  }

  async prepareDraftResponse(id: string): Promise<VaultFullResponse> {
    const vault = await this.vaultsRepository.findOne({
      where: { id },
      relations: ['owner', 'social_links', 'acquirer_whitelist', 'tags', 'vault_image', 'banner_image', 'ft_token_img'],
    });

    if (!vault) {
      throw new BadRequestException('Vault not found');
    }
    return plainToInstance(VaultFullResponse, vault, { excludeExtraneousValues: true });
  }

  async getAcquire(): Promise<VaultAcquireResponse[]> {
    const vaults = await this.vaultsRepository
      .createQueryBuilder('vault')
      .leftJoinAndSelect('vault.vault_image', 'file')
      .select([
        'vault.id',
        'vault.name',
        'vault.total_assets_cost_ada',
        'vault.total_assets_cost_usd',
        'vault.acquire_phase_start',
        'vault.acquire_window_duration',
        'vault.privacy',
        'vault.vault_status',
        'file.file_url',
      ])
      .where('vault.privacy = :privacy', { privacy: VaultPrivacy.public })
      .andWhere('vault.vault_status = :status', { status: VaultStatus.acquire })
      .orderBy('vault.total_assets_cost_ada', 'DESC')
      .take(5)
      .getMany();

    return vaults.map(vault => {
      const start = new Date(vault.acquire_phase_start);
      const duration = Number(vault.acquire_window_duration);
      const timeLeft = new Date(start.getTime() + duration);
      return {
        ...vault,
        timeLeft: timeLeft.toISOString(),
      } as VaultAcquireResponse;
    });
  }

  /**
   * Retrieves a vault by ID for a user, including asset and price calculations.
   * @param vaultId - Vault ID
   * @param userId - (Optional) User ID for access control
   * @returns Full vault response
   */
  async getVaultById(vaultId: string, userId?: string): Promise<VaultFullResponse> {
    const vault = await this.vaultsRepository.findOne({
      where: { id: vaultId, deleted: false, vault_status: Not(VaultStatus.draft) },
      relations: [
        'social_links',
        'assets_whitelist',
        'acquirer_whitelist',
        'vault_image',
        'banner_image',
        'ft_token_img',
        'tags',
      ],
      join: {
        alias: 'vault',
        leftJoinAndSelect: {
          owner: 'vault.owner',
        },
      },
      loadRelationIds: {
        relations: ['owner'],
        disableMixedMap: true,
      },
    });

    if (!vault) {
      throw new BadRequestException('Vault not found');
    }

    // Get count of locked assets for this vault
    const assetCounts = await this.assetsRepository
      .createQueryBuilder('asset')
      .select(['asset.type', 'COUNT(asset.id) as count', 'SUM(asset.quantity) as totalQuantity'])
      .where('asset.vault_id = :vaultId', { vaultId: vaultId })
      .andWhere('asset.status = :status', { status: AssetStatus.LOCKED })
      .andWhere('asset.origin_type = :originType', { originType: AssetOriginType.CONTRIBUTED })
      .groupBy('asset.type')
      .getRawMany();

    let lockedNFTCount = 0;
    let lockedFTsCount = 0;

    assetCounts.forEach(result => {
      if (result.asset_type === AssetType.NFT) {
        lockedNFTCount = parseInt(result.count);
      } else if (result.asset_type === AssetType.FT) {
        lockedFTsCount = parseInt(result.totalquantity);
      }
    });

    const lockedAssetsCount = lockedNFTCount + lockedFTsCount;
    const assetsPrices = await this.taptoolsService.calculateVaultAssetsValue(vaultId);

    const adaPrice = await this.taptoolsService.getAdaPrice();

    const additionalData = {
      maxContributeAssets: Number(vault.max_contribute_assets),
      requireReservedCostUsd:
        assetsPrices.totalValueUsd * (vault.acquire_reserve * 0.01) * (vault.tokens_for_acquires * 0.01),
      requireReservedCostAda:
        assetsPrices.totalValueAda * (vault.acquire_reserve * 0.01) * (vault.tokens_for_acquires * 0.01),
      assetsCount: lockedAssetsCount,
      assetsPrices,
      fdvAda: vault.fdv * adaPrice,
    };

    let canCreateProposal = false;
    let isChatVisible = false;

    if (userId) {
      try {
        isChatVisible = await this.checkChat(userId, vaultId);
      } catch (error) {
        isChatVisible = false;
      }
    }

    if (userId && vault.vault_status === VaultStatus.locked) {
      try {
        canCreateProposal = await this.governanceService.canUserCreateProposal(vaultId, userId);
      } catch (error) {
        canCreateProposal = false;
      }
    }

    let isWhitelistedContributor = vault.privacy === VaultPrivacy.public || vault.owner.id === userId;
    let isWhitelistedAcquirer = vault.privacy === VaultPrivacy.public || vault.owner.id === userId;

    if (userId && vault.privacy !== VaultPrivacy.public && vault.owner.id !== userId) {
      const user = await this.usersRepository.findOne({
        where: { id: userId },
        select: ['address'],
      });

      if (user) {
        isWhitelistedContributor = await this.contributorWhitelistRepository.exists({
          where: { vault: { id: vaultId }, wallet_address: user.address },
        });

        isWhitelistedAcquirer = await this.acquirerWhitelistRepository.exists({
          where: { vault: { id: vaultId }, wallet_address: user.address },
        });
      }
    }

    additionalData['isWhitelistedContributor'] = isWhitelistedContributor;
    additionalData['isWhitelistedAcquirer'] = isWhitelistedAcquirer;
    additionalData['canCreateProposal'] = canCreateProposal;
    additionalData['isChatVisible'] = isChatVisible;
    additionalData['valuationAmount'] =
      assetsPrices.totalAcquiredAda && vault.tokens_for_acquires
        ? parseFloat((assetsPrices.totalAcquiredAda / (vault.tokens_for_acquires * 0.01)).toFixed(2))
        : 0;

    // First transform the vault to plain object with class-transformer
    const plainVault = instanceToPlain(vault);

    // Then merge with additional data
    const result = {
      ...plainVault,
      ...additionalData,
      policyId: vault.script_hash,
    };

    return plainToInstance(VaultFullResponse, result, { excludeExtraneousValues: true });
  }

  async checkChat(userId: string, vaultId: string): Promise<boolean> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: ['id', 'address'],
    });

    if (!user) {
      return false;
    }

    const result = await this.vaultsRepository
      .createQueryBuilder('vault')
      .leftJoin('vault.snapshots', 'snapshot')
      .leftJoin(
        'transactions',
        'transaction',
        'transaction.vault_id = vault.id AND transaction.user_id = :userId AND transaction.status = :confirmedStatus'
      )
      .select('vault.id')
      .addSelect('vault.owner_id')
      .addSelect('snapshot.address_balances')
      .addSelect('transaction.id', 'has_transaction')
      .where('vault.id = :vaultId', { vaultId })
      .andWhere('vault.deleted = false')
      .orderBy('snapshot.created_at', 'DESC')
      .setParameters({
        userId,
        confirmedStatus: TransactionStatus.confirmed,
      })
      .getRawOne();

    if (!result) {
      return false;
    }

    if (result.owner_id === userId) {
      return true;
    }

    if (result.address_balances?.[user.address]) {
      return true;
    }

    return !!result.has_transaction;
  }

  /**
   * Retrieves paginated and filtered list of vaults accessible to the user, with access control and sorting.
   * @returns Paginated response of vaults
   */
  async getVaults(data: {
    userId?: string;
    filter?: VaultFilter;
    page?: number;
    limit?: number;
    sortBy?: VaultSortField;
    sortOrder?: SortOrder;
    tags?: string[];
    myVaults?: boolean;
    reserveMet?: boolean;
    isPublicOnly?: boolean;
    minInitialVaultOffered?: number;
    maxInitialVaultOffered?: number;
    assetWhitelist?: string;
    minTvl?: number;
    maxTvl?: number;
    tvlCurrency?: TVLCurrency;
    contributionWindow?: DateRangeDto;
    acquireWindow?: DateRangeDto;
    ownerId?: string;
    search?: string;
  }): Promise<PaginatedResponseDto<VaultShortResponse>> {
    const {
      userId,
      sortBy,
      tvlCurrency,
      minTvl,
      maxTvl,
      minInitialVaultOffered,
      maxInitialVaultOffered,
      contributionWindow,
      acquireWindow,
      tags,
      assetWhitelist,
      myVaults,
      filter,
      page = 1,
      limit = 10,
      sortOrder = SortOrder.DESC,
      reserveMet,
      search,
    } = data;

    // Create base query for all vaults
    const queryBuilder = this.vaultsRepository
      .createQueryBuilder('vault')
      .leftJoinAndSelect('vault.social_links', 'social_links')
      .leftJoinAndSelect('vault.assets_whitelist', 'assets_whitelist')
      .leftJoinAndSelect('vault.vault_image', 'vault_image')
      .leftJoinAndSelect('vault.banner_image', 'banner_image')
      .leftJoinAndSelect('vault.ft_token_img', 'ft_token_img')
      .leftJoinAndSelect('vault.tags', 'tags')
      .leftJoinAndSelect('vault.contributor_whitelist', 'contributor_whitelist')
      .leftJoinAndSelect('vault.acquirer_whitelist', 'acquirer_whitelist')
      .andWhere('vault.deleted != :deleted', { deleted: true })
      .andWhere('vault.vault_status != :createdStatus', { createdStatus: VaultStatus.created });

    // If userId is provided, retrieve user information and apply personalized filters
    let userWalletAddress: string | null = null;

    if (userId) {
      const user = await this.usersRepository.findOne({
        where: { id: userId },
      });

      if (user) {
        if (myVaults) {
          queryBuilder.andWhere(
            new Brackets(qb => {
              qb.where('vault.owner_id = :userId', { userId }).orWhere(
                `EXISTS (
                  SELECT 1 FROM assets
                  WHERE assets.vault_id = vault.id 
                  AND assets.added_by = :userId
                  AND assets.status IN ('locked', 'distributed')
                )`,
                { userId }
              );
            })
          );
        }

        userWalletAddress = user.address;
        queryBuilder.andWhere(
          new Brackets(qb => {
            // Include public vaults OR vaults where user is whitelisted or the owner
            qb.where('vault.privacy = :publicPrivacy', { publicPrivacy: VaultPrivacy.public })
              .orWhere('vault.owner_id = :userId', { userId })
              .orWhere(
                '(vault.privacy != :publicPrivacy AND EXISTS (SELECT 1 FROM contributor_whitelist cw WHERE cw.vault_id = vault.id AND cw.wallet_address = :userWalletAddress))',
                { publicPrivacy: VaultPrivacy.public, userWalletAddress }
              )
              .orWhere(
                '(vault.privacy != :publicPrivacy AND EXISTS (SELECT 1 FROM acquirer_whitelist aw WHERE aw.vault_id = vault.id AND aw.wallet_address = :userWalletAddress))',
                { publicPrivacy: VaultPrivacy.public, userWalletAddress }
              );
          })
        );
      }
    } else if (data.ownerId) {
      // only show public vaults
      queryBuilder.andWhere('vault.owner_id = :ownerId', { ownerId: data.ownerId });
      queryBuilder.andWhere('vault.privacy = :publicPrivacy', { publicPrivacy: VaultPrivacy.public });
    } else {
      queryBuilder.andWhere('vault.privacy = :publicPrivacy', { publicPrivacy: VaultPrivacy.public });
    }

    if (search) {
      queryBuilder.andWhere(
        new Brackets(qb => {
          qb.where('vault.name ILIKE :search', { search: `%${search}%` }).orWhere('vault.policy_id ILIKE :search', {
            search: `%${search}%`,
          });
        })
      );
    }

    // Apply status filter and corresponding whitelist check
    if (filter) {
      switch (filter) {
        case VaultFilter.open:
          queryBuilder.andWhere('vault.vault_status IN (:...statuses)', {
            statuses: [VaultStatus.published, VaultStatus.contribution, VaultStatus.acquire],
          });
          break;
        case VaultFilter.contribution:
          queryBuilder.andWhere('vault.vault_status = :status', { status: VaultStatus.contribution });
          break;
        case VaultFilter.acquire:
          queryBuilder.andWhere('vault.vault_status = :status', { status: VaultStatus.acquire });
          break;
        case VaultFilter.locked:
          queryBuilder.andWhere('vault.vault_status = :status', { status: VaultFilter.locked });
          break;
        case VaultFilter.govern:
          queryBuilder.andWhere('vault.vault_status = :status', { status: VaultFilter.locked }).andWhere(
            `
              EXISTS (
                SELECT 1
                FROM proposal
                WHERE proposal.vault_id = vault.id
                AND proposal.status = :activeStatus
              )
            `,
            { activeStatus: ProposalStatus.ACTIVE }
          );
          break;
        case VaultFilter.failed:
          queryBuilder.andWhere('vault.vault_status = :status', { status: VaultFilter.failed });
          break;
        case VaultFilter.terminated:
          queryBuilder.andWhere('vault.vault_status = :status', { status: VaultStatus.burned });
          break;
        case VaultFilter.draft:
          if (!myVaults || !userId) {
            throw new BadRequestException('Draft filter requires authentication');
          }
          queryBuilder.andWhere('vault.vault_status = :status', { status: VaultStatus.draft });
          break;
        case VaultFilter.published:
          queryBuilder.andWhere('vault.vault_status = :status', { status: VaultStatus.published });
          break;
        case VaultFilter.all: {
          const statuses = [
            VaultStatus.published,
            VaultStatus.contribution,
            VaultStatus.acquire,
            VaultStatus.locked,
            VaultStatus.burned,
          ];

          if (myVaults) {
            statuses.push(VaultStatus.draft);
          }

          queryBuilder.andWhere('vault.vault_status IN (:...statuses)', { statuses });
          break;
        }
      }
    }

    if (tags && tags.length > 0) {
      const normalizedTags = tags.map(tag => tag.toLowerCase());
      // OR logic: Returns vaults that have ANY of the specified tags
      queryBuilder.andWhere(
        `EXISTS (
          SELECT 1 
          FROM vault_tags vt 
          INNER JOIN tags t ON t.id = vt.tag_id 
          WHERE vt.vault_id = vault.id 
          AND LOWER(t.name) IN (:...tags)
        )`,
        { tags: normalizedTags }
      );
    }

    if (contributionWindow) {
      queryBuilder.andWhere('vault.contribution_open_window_time BETWEEN :start AND :end', {
        start: contributionWindow.from,
        end: contributionWindow.to,
      });
    }

    if (acquireWindow) {
      queryBuilder.andWhere('vault.acquire_open_window_time BETWEEN :start AND :end', {
        start: acquireWindow.from,
        end: acquireWindow.to,
      });
    }

    if (minTvl) {
      if (tvlCurrency === TVLCurrency.USD) {
        queryBuilder.andWhere('vault.total_assets_cost_usd >= :minTvl', { minTvl });
      } else if (tvlCurrency === TVLCurrency.ADA) {
        queryBuilder.andWhere('vault.total_assets_cost_ada >= :minTvl', { minTvl });
      }
    }

    if (maxTvl) {
      if (tvlCurrency === TVLCurrency.USD) {
        queryBuilder.andWhere('vault.total_assets_cost_usd <= :maxTvl', { maxTvl });
      } else if (tvlCurrency === TVLCurrency.ADA) {
        queryBuilder.andWhere('vault.total_assets_cost_ada <= :maxTvl', { maxTvl });
      }
    }

    if (maxInitialVaultOffered) {
      queryBuilder.andWhere('(100 - vault.acquire_reserve) <= :maxInitialVaultOffered', { maxInitialVaultOffered });
    }

    if (minInitialVaultOffered) {
      queryBuilder.andWhere('(100 - vault.acquire_reserve) >= :minInitialVaultOffered', { minInitialVaultOffered });
    }

    if (assetWhitelist) {
      queryBuilder.andWhere(
        `EXISTS (
          SELECT 1 
          FROM assets_whitelist aw 
          WHERE aw.vault_id = vault.id 
          AND aw.policy_id = :assetWhitelist
        )`,
        { assetWhitelist }
      );
    }

    // Apply sorting
    if (sortBy) {
      queryBuilder.orderBy(`vault.${sortBy}`, sortOrder);
    } else {
      // Default sort by created_at DESC
      queryBuilder.orderBy('vault.created_at', SortOrder.DESC);
    }

    // Get paginated results
    const [items, total] = await queryBuilder
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    // Transform vault images to URLs and convert to VaultShortResponse

    const transformedItems = await Promise.all(
      items.map(async vault => {
        // Create plain object from entity
        const plainVault = instanceToPlain(vault);

        const { phaseStartTime, phaseEndTime } = this.calculatePhaseTime(vault);

        // Current time for timeRemaining calculation
        const now = new Date();
        const endTime = phaseEndTime ? new Date(phaseEndTime) : null;
        const timeRemaining = endTime ? Math.max(0, endTime.getTime() - now.getTime()) : null;

        const assetsPrices = await this.taptoolsService.calculateVaultAssetsValue(vault.id);

        if (reserveMet !== undefined) {
          const totalAcquiredAda = assetsPrices.totalAcquiredAda;
          const requireReservedCostAda = vault.require_reserved_cost_ada;
          const reserveMetCalculated = totalAcquiredAda >= requireReservedCostAda;

          if (reserveMet && !reserveMetCalculated) return null;
          if (!reserveMet && reserveMetCalculated) return null;
        }

        // Merge calculated values with plain object
        const enrichedVault = {
          ...plainVault,
          totalValueUsd: assetsPrices.totalValueUsd,
          totalValueAda: assetsPrices.totalValueAda,
          baseAllocation: null,
          total: null,
          invested: vault.total_acquired_value_ada,
          phaseStartTime: phaseStartTime ? phaseStartTime.toISOString() : null,
          phaseEndTime: phaseEndTime ? phaseEndTime.toISOString() : null,
          timeRemaining,
        };

        // Transform to DTO with class-transformer
        return plainToInstance(VaultShortResponse, enrichedVault, {
          excludeExtraneousValues: true,
        });
      })
    );

    const filteredItems = transformedItems.filter(vault => vault !== null);

    return {
      items: filteredItems,
      total: filteredItems.length,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Calculates when the current phase ends for a vault
   * @param vault - Vault entity
   * @returns Date when the current phase ends
   */
  private calculatePhaseTime(vault: Vault): {
    phaseStartTime: Date | null;
    phaseEndTime: Date | null;
  } {
    try {
      let phaseStartTime: Date | null = null;
      let phaseEndTime: Date | null = null;

      switch (vault.vault_status) {
        case VaultStatus.published:
          // For published vaults, start time is when it was published
          phaseStartTime = new Date(vault.created_at);

          // End time is when contribution phase starts
          if (vault.contribution_open_window_type === ContributionWindowType.uponVaultLaunch) {
            phaseEndTime = new Date(phaseStartTime.getTime() + Number(vault.contribution_duration));
          } else if (vault.contribution_open_window_time) {
            phaseEndTime = new Date(Number(vault.contribution_open_window_time));
          }
          break;

        case VaultStatus.contribution:
          // Start time is either actual contribution_phase_start or fallback to planned time
          phaseStartTime = vault.contribution_phase_start
            ? new Date(vault.contribution_phase_start)
            : vault.contribution_open_window_time
              ? new Date(Number(vault.contribution_open_window_time))
              : null;

          // End time is start time + duration
          if (phaseStartTime) {
            phaseEndTime = new Date(phaseStartTime.getTime() + Number(vault.contribution_duration));
          }
          break;

        case VaultStatus.acquire:
          // Start time is either actual acquire_phase_start or fallback to planned time
          phaseStartTime = vault.acquire_phase_start
            ? new Date(vault.acquire_phase_start)
            : vault.acquire_open_window_time
              ? new Date(Number(vault.acquire_open_window_time))
              : null;

          // End time is start time + duration
          if (phaseStartTime) {
            phaseEndTime = new Date(phaseStartTime.getTime() + Number(vault.acquire_window_duration));
          }
          break;

        case VaultStatus.locked:
          // Start time is when the vault was locked
          phaseStartTime = vault.locked_at ? new Date(vault.locked_at) : null;
          // No end time for locked vaults
          phaseEndTime = null;
          break;

        default:
          phaseStartTime = null;
          phaseEndTime = null;
      }

      return { phaseStartTime, phaseEndTime };
    } catch (error) {
      this.logger.error(`Error calculating phase times for vault ${vault.id}:`, error);
      return { phaseStartTime: null, phaseEndTime: null };
    }
  }

  /**
   * Attempts to burn (liquidate) a vault, creating a burn transaction if the vault is empty and owned by the user.
   * @param vaultId - Vault ID
   * @param userId - User ID
   * @returns Burn transaction result
   */
  async buildBurnTransaction(
    vaultId: string,
    userId: string
  ): Promise<{
    txId: string;
    presignedTx: string;
  }> {
    const vault = await this.vaultsRepository.findOne({
      where: {
        id: vaultId,
        owner: {
          id: userId,
        },
      },
      relations: ['assets', 'owner'],
    });
    if (!vault) {
      throw new Error('Vault is not found or you are not owner of this vault!');
    }
    if (vault.assets.length !== 0) {
      throw new Error('The vault cant be burned it need to extract and refound assets ');
    }
    const transaction = await this.transactionsService.createTransaction({
      vault_id: vaultId,
      type: TransactionType.burn,
      assets: [],
    });
    const result = await this.vaultContractService.createBurnTx({
      assetVaultName: vault.asset_vault_name,
      customerAddress: vault.owner.address,
    });

    return {
      ...result,
      txId: transaction.id,
    };
  }

  /**
   * Publishes a burn transaction for a vault, marking it as deleted and saving the liquidation hash.
   * @param vaultId - Vault ID
   * @param userId - User ID
   * @param publishDto - PublishVaultDto containing transaction data
   */
  async publishBurnTransaction(
    vaultId: string,
    userId: string,
    publishDto: PublishVaultDto
  ): Promise<{
    txHash: string;
  }> {
    this.logger.log(`Attempting to publish burn transaction for vault ${vaultId} by user ${userId}`);

    try {
      const vault = await this.vaultsRepository.findOne({
        where: {
          id: vaultId,
          owner: { id: userId },
        },
      });

      if (!vault) {
        throw new UnauthorizedException('Vault is not found or you are not the owner of this vault');
      }

      const { txHash } = await this.blockchainService.submitTransaction({
        transaction: publishDto.transaction,
        signatures: publishDto.signatures,
      });

      vault.deleted = true;
      vault.liquidation_hash = txHash;
      vault.vault_status = VaultStatus.burned;

      await this.vaultsRepository.save(vault);
      await this.transactionsService.updateTransactionHash(publishDto.txId, txHash);

      this.logger.log(`Vault ${vaultId} successfully marked as burned`);

      return { txHash };
    } catch (error) {
      this.logger.error(`Error publishing burn transaction for vault ${vaultId}:`, error);
      throw error;
    }
  }

  async incrementViewCount(vaultId: string): Promise<UpdateResult> {
    return await this.vaultsRepository.increment({ id: vaultId }, 'count_view', 1);
  }

  private calculateOptimalDecimals(tokenSupply: number): number {
    const maxSafeDecimals = Math.floor(Math.log10(Number.MAX_SAFE_INTEGER / tokenSupply));

    let targetDecimals: number;
    if (tokenSupply >= 900_000_000_000) {
      targetDecimals = 1;
    } else if (tokenSupply >= 90_000_000_000) {
      targetDecimals = 1;
    } else if (tokenSupply >= 9_000_000_000) {
      targetDecimals = 2;
    } else if (tokenSupply >= 900_000_000) {
      targetDecimals = 3;
    } else if (tokenSupply >= 90_000_000) {
      targetDecimals = 4;
    } else if (tokenSupply >= 9_000_000) {
      targetDecimals = 5;
    } else if (tokenSupply >= 1_000_000) {
      targetDecimals = 6;
    } else {
      targetDecimals = 6;
    }

    const safeDecimals = Math.min(targetDecimals, maxSafeDecimals);

    if (safeDecimals < targetDecimals) {
      this.logger.warn(
        `Token supply ${tokenSupply}: target decimals ${targetDecimals} reduced to ${safeDecimals} for safety`
      );
    }

    return Math.max(safeDecimals, 0);
  }
}
