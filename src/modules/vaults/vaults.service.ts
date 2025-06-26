import { Credential, EnterpriseAddress, ScriptHash } from '@emurgo/cardano-serialization-lib-nodejs';
import { transformToSnakeCase } from '@/helpers';
import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { classToPlain, plainToInstance } from 'class-transformer';
import * as csv from 'csv-parse';
import { AcquirerWhitelistEntity } from '@/database/acquirerWhitelist.entity';
import { Asset } from '@/database/asset.entity';
import { AssetsWhitelistEntity } from '@/database/assetsWhitelist.entity';
import { ContributorWhitelistEntity } from '@/database/contributorWhitelist.entity';
import { FileEntity } from '@/database/file.entity';
import { LinkEntity } from '@/database/link.entity';
import { TagEntity } from '@/database/tag.entity';
import { User } from '@/database/user.entity';
import { Vault } from '@/database/vault.entity';
import { AssetOriginType, AssetStatus, AssetType } from '@/types/asset.types';
import { TransactionType } from '@/types/transaction.types';
import {
  ContributionWindowType,
  InvestmentWindowType,
  ValueMethod,
  VaultPrivacy,
  VaultStatus,
} from '@/types/vault.types';
import { Brackets, In, Repository } from 'typeorm';

import { AwsService } from '../aws_bucket/aws.service';
import { TaptoolsService } from '../taptools/taptools.service';

import { CreateVaultReq } from './dto/createVault.req';
import { SortOrder, VaultFilter, VaultSortField } from './dto/get-vaults.dto';
import { PaginatedResponseDto } from './dto/paginated-response.dto';
import { PublishVaultDto } from './dto/publish-vault.dto';
import { SaveDraftReq } from './dto/saveDraft.req';
import { VaultFullResponse, VaultShortResponse } from './dto/vault.response';
import { TransactionsService } from './processing-tx/offchain-tx/transactions.service';
import { BlockchainScannerService } from './processing-tx/onchain/blockchain-scanner.service';
import { valuation_sc_type, vault_sc_privacy } from './processing-tx/onchain/types/vault-sc-type';
import { applyContributeParams } from './processing-tx/onchain/utils/apply_params';
import { VaultManagingService } from './processing-tx/onchain/vault-managing.service';

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
    private readonly taptoolsService: TaptoolsService,
    private readonly transactionsService: TransactionsService,
    private readonly configService: ConfigService
  ) {}

  private async wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async confirmAndProcessTransaction(txHash: string, vault: Vault, attempt = 0): Promise<void> {
    try {
      this.logger.log(`Checking transaction status (attempt ${attempt + 1}): ${txHash}`);

      const txDetail = await this.blockchainScannerService.getTransactionDetails(txHash);

      if (!txDetail || !txDetail.output_amount || txDetail.output_amount.length < 2) {
        throw new Error('Transaction output not found or invalid format');
      }

      const { output_amount } = txDetail;
      const vaultPolicyPlusName = output_amount[output_amount.length - 1].unit;
      const VAULT_POLICY_ID = vaultPolicyPlusName.slice(0, 56);
      const VAULT_ID = vaultPolicyPlusName.slice(56);

      const parameterizedScript = applyContributeParams({
        vault_policy_id: VAULT_POLICY_ID,
        vault_id: VAULT_ID,
      });

      const POLICY_ID = parameterizedScript.validator.hash;
      const SC_ADDRESS = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex(POLICY_ID)))
        .to_address()
        .to_bech32();

      vault.contract_address = SC_ADDRESS;
      await this.vaultsRepository.save(vault);

      this.logger.log(`Successfully processed transaction ${txHash} for vault ${vault.id}`);
    } catch (error) {
      this.logger.log('Publication tx failed ');
      if (attempt >= this.MAX_RETRIES - 1) {
        this.logger.error(`Max retries reached for transaction ${txHash}:`, error);
        return;
      }

      // Exponential backoff: 3s, 6s, 12s, 24s, etc.
      const delay = this.INITIAL_RETRY_DELAY * Math.pow(2, attempt);
      this.logger.log(`Retrying in ${delay}ms...`);

      await this.wait(delay);
      return this.confirmAndProcessTransaction(txHash, vault, attempt + 1);
    }
  }

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

  async createVault(userId: string, data: CreateVaultReq): Promise<any> {
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

      // Process image files - allow reuse of existing files
      const imgKey = data.vaultImage?.split('image/')[1];
      let vaultImg = null;
      if (imgKey) {
        vaultImg = await this.filesRepository.findOne({
          where: { file_key: imgKey },
        });
        
        if (vaultImg) {
          // Check if this file is already used by another vault
          const existingVaultWithImage = await this.vaultsRepository.findOne({
            where: { vault_image: { id: vaultImg.id } },
          });
          
          if (existingVaultWithImage) {
            this.logger.log(`Vault image file ${imgKey} is already in use by vault ${existingVaultWithImage.id}, allowing reuse`);
            // We'll allow reuse by setting vaultImg to null so it won't be assigned
            vaultImg = null;
          }
        }
      }

      const ftTokenImgKey = data.ftTokenImg?.split('image/')[1];
      let ftTokenImg = null;
      if (ftTokenImgKey) {
        ftTokenImg = await this.filesRepository.findOne({
          where: { file_key: ftTokenImgKey },
        });
        
        if (ftTokenImg) {
          // Check if this file is already used by another vault
          const existingVaultWithFtImage = await this.vaultsRepository.findOne({
            where: { ft_token_img: { id: ftTokenImg.id } },
          });
          
          if (existingVaultWithFtImage) {
            this.logger.log(`FT token image file ${ftTokenImgKey} is already in use by vault ${existingVaultWithFtImage.id}, allowing reuse`);
            // We'll allow reuse by setting ftTokenImg to null so it won't be assigned
            ftTokenImg = null;
          }
        }
      }

      const acquirerWhitelistCsvKey = data.acquirerWhitelistCsv?.key;
      let acquirerWhitelistFile = null;
      if (acquirerWhitelistCsvKey) {
        acquirerWhitelistFile = await this.filesRepository.findOne({
          where: { file_key: acquirerWhitelistCsvKey },
        });
        
        if (acquirerWhitelistFile) {
          // Check if this file is already used by another vault
          const existingVaultWithCsv = await this.vaultsRepository.findOne({
            where: { acquirer_whitelist_csv: { id: acquirerWhitelistFile.id } },
          });
          
          if (existingVaultWithCsv) {
            this.logger.log(`Acquirer whitelist CSV file ${acquirerWhitelistCsvKey} is already in use by vault ${existingVaultWithCsv.id}, allowing reuse`);
            // We'll allow reuse by setting acquirerWhitelistFile to null so it won't be assigned
            acquirerWhitelistFile = null;
          }
        }
      }

      const contributorWhitelistCsvKey = data.contributorWhitelistCsv?.split('csv/')[1];
      const contributorWhitelistFile = contributorWhitelistCsvKey
        ? await this.filesRepository.findOne({
            where: { file_key: contributorWhitelistCsvKey },
          })
        : null;

      // Prepare vault data
      const vaultData = transformToSnakeCase({
        ...data,
        owner: owner,
        contributionDuration: data.contributionDuration,
        acquireWindowDuration: data.acquireWindowDuration,
        acquireOpenWindowTime: new Date(data.acquireOpenWindowTime).toISOString(),
        contributionOpenWindowTime: new Date(data.contributionOpenWindowTime).toISOString(),
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
      } catch (error) {
        // Handle unique constraint violation for file relations as fallback
        if (error.code === '23505' && error.detail?.includes('already exists')) {
          this.logger.warn('Duplicate key constraint violation during vault creation, retrying without file relations:', error.detail);
          
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
      let maxCountOf = 0;
      if (data.assetsWhitelist?.length > 0) {
        await Promise.all(
          data.assetsWhitelist.map(assetItem => {
            if (assetItem.policyId) {
              // Sum up the countCapMax values
              if (assetItem.countCapMax) {
                maxCountOf += assetItem.countCapMax;
              }
              return this.assetsWhitelistRepository.save({
                vault: newVault,
                policy_id: assetItem.policyId,
                asset_count_cap_min: assetItem.countCapMin,
                asset_count_cap_max: assetItem.countCapMax,
              });
            }
          })
        );
      }

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
        ? [...(data.contributorWhitelist.map(item => item.policyId) || [])]
        : [];

      const allContributors = new Set([...contributorList, ...contributorsFromCsv]);
      const contributorsArray = [...allContributors];

      contributorsArray.map(item => {
        return this.contributorWhitelistRepository.save({
          vault: newVault,
          wallet_address: item,
        });
      });

      // Handle tags
      if (data.tags?.length > 0) {
        const tags = await Promise.all(
          data.tags.map(async tagData => {
            let tag = await this.tagsRepository.findOne({
              where: { name: tagData.name },
            });
            if (!tag) {
              tag = await this.tagsRepository.save({
                name: tagData.name,
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

      const policyWhitelist = finalVault?.assets_whitelist.map(item => item.policy_id);

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

      const { presignedTx, contractAddress, vaultAssetName } = await this.vaultContractService.createOnChainVaultTx({
        vaultName: finalVault.name,
        customerAddress: finalVault.owner.address,
        vaultId: finalVault.id,
        allowedPolicies: policyWhitelist,
        contractType: privacy,
        valueMethod: valueMethod,
        assetWindow,
        acquireWindow,
      });

      finalVault.contract_address = contractAddress;
      finalVault.asset_vault_name = vaultAssetName;
      await this.vaultsRepository.save(finalVault);
      return {
        vaultId: finalVault.id,
        presignedTx,
      };
    } catch (error) {
      this.logger.error('Error creating vault:', error);
      
      // If it's already a BadRequestException, re-throw it
      if (error instanceof BadRequestException) {
        throw error;
      }
      
      // Handle database constraint violations as fallback
      if (error.code === '23505') {
        if (error.detail?.includes('vault_image_id')) {
          throw new BadRequestException('The selected vault image is already in use. The vault was created without the image.');
        }
        if (error.detail?.includes('ft_token_img_id')) {
          throw new BadRequestException('The selected FT token image is already in use. The vault was created without the image.');
        }
        if (error.detail?.includes('acquirer_whitelist_csv_id')) {
          throw new BadRequestException('The selected acquirer whitelist CSV is already in use. The vault was created without the CSV file.');
        }
        throw new BadRequestException('Some files you selected are already in use. The vault was created without those files.');
      }
      
      throw new BadRequestException('Failed to create vault. Please check your input and try again.');
    }
  }

  async publishVault(userId, signedTx) {
    const vault = await this.vaultsRepository.findOne({
      where: {
        id: signedTx.vaultId,
      },
      relations: ['owner'],
    });
    if (vault.owner.id !== userId) {
      throw new UnauthorizedException('You must be an owner of vault!');
    }

    const publishedTx = await this.vaultContractService.submitOnChainVaultTx(signedTx);
    vault.vault_status = VaultStatus.published;
    vault.publication_hash = publishedTx.txHash;
    await this.vaultsRepository.save(vault);
    // Start transaction confirmation process in background
    this.confirmAndProcessTransaction(publishedTx.txHash, vault).catch(error => {
      this.logger.error(`Failed to process transaction ${publishedTx.txHash}:`, error);
    });

    return plainToInstance(VaultFullResponse, classToPlain(vault), { excludeExtraneousValues: true });
  }

  async saveDraftVault(userId: string, data: SaveDraftReq): Promise<any> {
    let existingVault: Vault | null = null;

    // Check for existing draft vault if ID is provided
    if (data.id) {
      existingVault = await this.vaultsRepository.findOne({
        where: {
          id: data.id,
          vault_status: VaultStatus.draft,
          owner: { id: userId },
        },
        relations: ['owner', 'social_links', 'assets_whitelist', 'acquirer_whitelist'],
      });

      // If found but not a draft, throw error
      if (existingVault && existingVault.vault_status !== VaultStatus.draft) {
        throw new BadRequestException('Cannot modify a published vault');
      }

      // If found and is draft, remove existing relationships
      if (existingVault) {
        if (existingVault.social_links?.length > 0) {
          await this.linksRepository.remove(existingVault.social_links);
        }
        if (existingVault.assets_whitelist?.length > 0) {
          await this.assetsWhitelistRepository.remove(existingVault.assets_whitelist);
        }
        if (existingVault.acquirer_whitelist?.length > 0) {
          await this.acquirerWhitelistRepository.remove(existingVault.acquirer_whitelist);
        }
      }
    }
    try {
      const owner = await this.usersRepository.findOne({
        where: { id: userId },
      });

      // Process image files
      const imgKey = data.vaultImage?.split('image/')[1];
      const vaultImg = imgKey
        ? await this.filesRepository.findOne({
            where: { file_key: imgKey },
          })
        : null;

      const bannerImgKey = data.bannerImage?.split('image/')[1];
      const bannerImg = bannerImgKey
        ? await this.filesRepository.findOne({
            where: { file_key: bannerImgKey },
          })
        : null;

      const ftTokenImgKey = data.ftTokenImg?.split('image/')[1];
      const ftTokenImg = ftTokenImgKey
        ? await this.filesRepository.findOne({
            where: { file_key: ftTokenImgKey },
          })
        : null;

      const acquirerWhitelistCsvKey = data.acquirerWhitelistCsv?.key;
      const acquirerWhitelistFile = acquirerWhitelistCsvKey
        ? await this.filesRepository.findOne({
            where: { file_key: acquirerWhitelistCsvKey },
          })
        : null;

      // Prepare vault data with only the provided fields
      const vaultData: any = {
        owner: owner,
        vault_status: VaultStatus.draft,
      };

      // Only include fields that are actually provided
      if (data.name !== undefined) vaultData.name = data.name;
      if (data.type !== undefined) vaultData.type = data.type;
      if (data.privacy !== undefined) vaultData.privacy = data.privacy;
      if (data.valueMethod !== undefined) vaultData.value_method = data.valueMethod;
      if (data.valuationCurrency !== undefined) vaultData.valuation_currency = data.valuationCurrency;
      if (data.valuationAmount !== undefined) vaultData.valuation_amount = data.valuationAmount;
      if (data.description !== undefined) vaultData.description = data.description;
      if (data.ftTokenDecimals) vaultData.ftToken_decimals = data.ftTokenDecimals;
      if (data.acquireOpenWindowType) vaultData.acquire_open_window_type = data.acquireOpenWindowType;

      // Handle date fields only if they are provided
      if (data.contributionDuration !== undefined) {
        vaultData.contribution_duration = data.contributionDuration;
      }
      if (data.acquireWindowDuration !== undefined) {
        vaultData.acquire_window_duration = data.acquireWindowDuration;
      }
      if (data.acquireOpenWindowTime !== undefined) {
        vaultData.acquire_open_window_time = new Date(data.acquireOpenWindowTime).toISOString();
      }
      if (data.contributionOpenWindowTime !== undefined) {
        vaultData.contribution_open_window_time = new Date(data.contributionOpenWindowTime).toISOString();
      }
      if (data.timeElapsedIsEqualToTime !== undefined) {
        vaultData.time_elapsed_is_equal_to_time = data.timeElapsedIsEqualToTime;
      }

      // Handle file relationships only if provided
      if (vaultImg) vaultData.vault_image = vaultImg;
      if (bannerImg) vaultData.banner_image = bannerImg;
      if (ftTokenImg) vaultData.ft_token_img = ftTokenImg;
      if (acquirerWhitelistFile) vaultData.acquirer_whitelist_csv = acquirerWhitelistFile;

      let vault: Vault;
      if (existingVault) {
        // Update only the provided fields in existing draft vault
        vault = (await this.vaultsRepository.save({
          ...existingVault,
          ...vaultData,
        })) as Vault;
      } else {
        // Create new draft vault with provided fields
        vault = await this.vaultsRepository.save(vaultData as Vault);
      }

      // Handle social links only if provided
      if (data.socialLinks !== undefined) {
        if (data.socialLinks.length > 0) {
          const links = data.socialLinks.map(linkItem => {
            return this.linksRepository.create({
              vault: vault,
              name: linkItem.name,
              url: linkItem.url,
            });
          });
          await this.linksRepository.save(links);
        }
      }

      if (data.tags?.length > 0) {
        const tags = await Promise.all(
          data.tags.map(async tagData => {
            let tag = await this.tagsRepository.findOne({
              where: { name: tagData.name },
            });
            if (!tag) {
              tag = await this.tagsRepository.save({
                name: tagData.name,
              });
            }
            return tag;
          })
        );
        vault.tags = tags;
        await this.vaultsRepository.save(vault);
      }

      // Handle assets whitelist only if provided
      if (data.assetsWhitelist !== undefined && data.assetsWhitelist.length > 0) {
        await Promise.all(
          data.assetsWhitelist.map(whitelistItem => {
            return this.assetsWhitelistRepository.save({
              vault: vault,
              policy_id: whitelistItem.policyId,
              asset_count_cap_min: whitelistItem?.countCapMin,
              asset_count_cap_max: whitelistItem?.countCapMax,
            });
          })
        );
      }

      // Handle acquirer whitelist only if provided
      if (data.acquirerWhitelist !== undefined || acquirerWhitelistFile) {
        const acquirerFromCsv = acquirerWhitelistFile ? await this.parseCSVFromS3(acquirerWhitelistFile.file_key) : [];

        const manualAcquirer = data.acquirerWhitelist?.map(item => item.walletAddress) || [];
        const allAcquirer = new Set([...manualAcquirer, ...acquirerFromCsv]);

        if (allAcquirer.size > 0) {
          const investorItems = Array.from(allAcquirer).map(walletAddress => {
            return this.acquirerWhitelistRepository.create({
              vault: vault,
              wallet_address: walletAddress,
            });
          });
          await this.acquirerWhitelistRepository.save(investorItems);
        }
      }

      return await this.prepareDraftResponse(vault.id);
    } catch (error) {
      console.error(error);
      throw new BadRequestException('Failed to create vault');
    }
  }

  async getMyVaults(
    userId: string,
    filter?: VaultFilter,
    page: number = 1,
    limit: number = 10,
    sortBy?: VaultSortField,
    sortOrder: SortOrder = SortOrder.DESC
  ): Promise<PaginatedResponseDto<VaultShortResponse>> {
    const query = {
      where: {
        owner: { id: userId },
        deleted: false,
      },
      relations: ['social_links', 'vault_image', 'banner_image'],
      skip: (page - 1) * limit,
      take: limit,
      order: {},
    };

    if (filter) {
      switch (filter) {
        case VaultFilter.open:
          query.where['vault_status'] = In([VaultStatus.published, VaultStatus.contribution, VaultStatus.acquire]);
          break;
        case VaultFilter.locked:
          query.where['vault_status'] = VaultStatus.locked;
          break;
        case VaultFilter.contribution:
          query.where['vault_status'] = VaultStatus.contribution;
          break;
        case VaultFilter.acquire:
          query.where['vault_status'] = VaultStatus.acquire;
          break;
        case VaultFilter.governance:
          query.where['vault_status'] = VaultStatus.governance;
          break;
      }
    }

    // Add sorting if specified
    if (sortBy) {
      query.order[sortBy] = sortOrder;
    } else {
      // Default sort by created_at DESC if no sort specified
      query.order['created_at'] = SortOrder.DESC;
    }

    const [listOfVaults, total] = await this.vaultsRepository.findAndCount(query);

    // Transform vault images to URLs and convert to VaultShortResponse
    const transformedItems = listOfVaults.map(vault => {
      return plainToInstance(VaultShortResponse, classToPlain(vault), { excludeExtraneousValues: true });
    });

    return {
      items: transformedItems,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async prepareDraftResponse(id: string) {
    const vault = await this.vaultsRepository.findOne({
      where: { id },
      relations: ['owner', 'social_links', 'acquirer_whitelist', 'tags', 'vault_image', 'banner_image', 'ft_token_img'],
    });

    if (!vault) {
      throw new BadRequestException('Vault not found');
    }
    return plainToInstance(VaultFullResponse, vault, { excludeExtraneousValues: true });
  }

  async getVaultById(id: string, _userId: string): Promise<VaultFullResponse> {
    const vault = await this.vaultsRepository.findOne({
      where: { id, deleted: false },
      relations: [
        'owner',
        'social_links',
        'assets_whitelist',
        'acquirer_whitelist',
        'vault_image',
        'banner_image',
        'ft_token_img',
      ],
    });

    if (!vault) {
      throw new BadRequestException('Vault not found');
    }

    if (vault.privacy !== VaultPrivacy.public) {
      throw new BadRequestException('Access denied: You are not the owner of this vault');
    }

    // Get count of locked assets for this vault
    const lockedAssetsCount = await this.assetsRepository.count({
      where: {
        vault: { id },
        status: AssetStatus.LOCKED,
        type: AssetType.NFT,
        origin_type: AssetOriginType.CONTRIBUTED,
      },
    });

    // todo this is ok for contribution phase, but we need to calculate only assets with origin type CONTRIBUTED
    const assetsPrices = await this.taptoolsService.calculateVaultAssetsValue(id);

    // todo for calculate how much ada already invested we need to select assets with INVESTED origin type.
    // todo and here we got how much invested now
    // const investedAssetsPrice = await this.taptoolsService.calculateVaultAssetsValue(id, 'acquire');

    // Create a new plain object with the additional properties
    const additionalData = {
      maxContributeAssets: Number(vault.max_contribute_assets),
      assetsCount: lockedAssetsCount,
      assetsPrices: assetsPrices,
      requireReservedCostAda: assetsPrices.totalValueAda * (vault.acquire_reserve * 0.01),
      requireReservedCostUsd: assetsPrices.totalValueUsd * (vault.acquire_reserve * 0.01),
    };

    // First transform the vault to plain object with class-transformer
    const plainVault = classToPlain(vault);

    // Then merge with additional data
    const result = {
      ...plainVault,
      ...additionalData,
    };

    return plainToInstance(VaultFullResponse, result, { excludeExtraneousValues: true });
  }

  async getVaults(
    userId: string,
    filter?: VaultFilter,
    page: number = 1,
    limit: number = 10,
    sortBy?: VaultSortField,
    sortOrder: SortOrder = SortOrder.DESC
  ): Promise<PaginatedResponseDto<VaultShortResponse>> {
    // Get user's wallet address
    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    const userWalletAddress = user.address;

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
      .where('vault.vault_status != :draftStatus', { draftStatus: VaultStatus.draft })
      .andWhere('vault.deleted != :deleted', { deleted: true })
      .andWhere('vault.vault_status != :createdStatus', { createdStatus: VaultStatus.created })
      // Get public vaults OR private vaults where user is whitelisted based on filter
      .andWhere(
        new Brackets(qb => {
          qb.where('vault.privacy = :publicPrivacy', { publicPrivacy: VaultPrivacy.public }).orWhere(
            new Brackets(qb2 => {
              qb2.where('vault.privacy = :privatePrivacy', { privatePrivacy: VaultPrivacy.private }).andWhere(
                new Brackets(qb3 => {
                  // Default case - check both whitelists if no filter
                  qb3.where(
                    '(EXISTS (SELECT 1 FROM contributor_whitelist cw WHERE cw.vault_id = vault.id AND cw.wallet_address = :userWalletAddress) OR EXISTS (SELECT 1 FROM acquirer_whitelist iw WHERE iw.vault_id = vault.id AND iw.wallet_address = :userWalletAddress))',
                    { userWalletAddress }
                  );
                })
              );
            })
          );
        })
      );

    // Apply status filter and corresponding whitelist check
    if (filter) {
      switch (filter) {
        case VaultFilter.open:
          queryBuilder
            .andWhere('vault.vault_status IN (:...statuses)', {
              statuses: [VaultStatus.published, VaultStatus.contribution, VaultStatus.acquire],
            })
            .andWhere(
              new Brackets(qb => {
                qb.where('vault.privacy = :publicPrivacy', { publicPrivacy: VaultPrivacy.public }).orWhere(
                  'EXISTS (SELECT 1 FROM contributor_whitelist cw WHERE cw.vault_id = vault.id AND cw.wallet_address = :userWalletAddress)',
                  { userWalletAddress }
                );
              })
            );
          break;
        case VaultFilter.contribution:
          queryBuilder.andWhere('vault.vault_status = :status', { status: VaultStatus.contribution }).andWhere(
            new Brackets(qb => {
              qb.where('vault.privacy = :publicPrivacy', { publicPrivacy: VaultPrivacy.public }).orWhere(
                'EXISTS (SELECT 1 FROM contributor_whitelist cw WHERE cw.vault_id = vault.id AND cw.wallet_address = :userWalletAddress)',
                { userWalletAddress }
              );
            })
          );
          break;
        case VaultFilter.acquire:
          queryBuilder.andWhere('vault.vault_status = :status', { status: VaultStatus.acquire }).andWhere(
            new Brackets(qb => {
              qb.where('vault.privacy = :publicPrivacy', { publicPrivacy: VaultPrivacy.public }).orWhere(
                'EXISTS (SELECT 1 FROM acquirer_whitelist iw WHERE iw.vault_id = vault.id AND iw.wallet_address = :userWalletAddress)',
                { userWalletAddress }
              );
            })
          );
          break;
        case VaultFilter.governance:
          queryBuilder.andWhere('vault.vault_status = :status', { status: VaultStatus.governance }).andWhere(
            new Brackets(qb => {
              qb.where('vault.privacy = :publicPrivacy', { publicPrivacy: VaultPrivacy.public }).orWhere(
                '(EXISTS (SELECT 1 FROM contributor_whitelist cw WHERE cw.vault_id = vault.id AND cw.wallet_address = :userWalletAddress) OR EXISTS (SELECT 1 FROM acquirer_whitelist iw WHERE iw.vault_id = vault.id AND iw.wallet_address = :userWalletAddress))',
                { userWalletAddress }
              );
            })
          );
          break;
        case VaultFilter.locked:
          queryBuilder.andWhere('vault.vault_status = :status', { status: VaultStatus.locked });
          break;
      }
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
    const transformedItems = items.map(vault => {
      return plainToInstance(VaultShortResponse, classToPlain(vault), { excludeExtraneousValues: true });
    });

    return {
      items: transformedItems,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async burnVaultAttempt(vaultId: string, userId: string) {
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

  async burnVaultPublishTx(vaultId, userId, publishDto: PublishVaultDto) {
    const { txHash } = await this.vaultContractService.submitOnChainVaultTx({
      transaction: publishDto.transaction,
      signatures: publishDto.signatures,
    });

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
    vault.deleted = true;
    vault.liquidation_hash = txHash;
    // todo need to wait tx approvement from scanner ?
    await this.transactionsService.updateTransactionHash(publishDto.txId, txHash);
    await this.vaultsRepository.save(vault);
  }
}
