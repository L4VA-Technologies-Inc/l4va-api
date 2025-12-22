import { Buffer } from 'buffer';
import * as crypto from 'crypto';

import { PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { firstValueFrom } from 'rxjs';
import sharp from 'sharp';
import { In, Repository } from 'typeorm';

import { TokenMetadataDto } from './dto/token-metadata.dto';

import { TokenRegistry } from '@/database/tokenRegistry.entity';
import { Vault } from '@/database/vault.entity';
import { TokenRegistryStatus } from '@/types/tokenRegistry.types';

type ItemData = {
  sequenceNumber: number;
  value: string | number;
  signatures: {
    signature: string;
    publicKey: string;
  }[];
};

type TokenMetaData = {
  subject: string; //	The base16-encoded policyId + base16-encoded assetName
  name: ItemData; // A human-readable name for the subject, suitable for use in an interface
  description: ItemData; // A human-readable description for the subject, suitable for use in an interface
  policy?: string; // The base16-encoded CBOR representation of the monetary policy script, used to verify ownership. Optional in the case of Plutus scripts as verification is handled elsewhere.
  ticker: ItemData; // A human-readable ticker name for the subject, suitable for use in an interface
  url?: ItemData; // A HTTPS URL (web page relating to the token)
  logo?: ItemData; // A PNG image file as a byte string
  decimals?: ItemData; // how many decimals to the token
};

// Deprecated: Use TokenMetadataDto instead
export type TokenMetaDatametadataInput = TokenMetadataDto;

@Injectable()
export class MetadataRegistryApiService {
  private readonly logger = new Logger(MetadataRegistryApiService.name);
  private readonly adminSKey: string;
  private readonly githubToken: string;
  private readonly repoOwner: string;
  private readonly repoName: string;
  private readonly folderName: string;

  constructor(
    @InjectRepository(TokenRegistry)
    private readonly tokenRegistryRepository: Repository<TokenRegistry>,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService
  ) {
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.githubToken = this.configService.get<string>('GITHUB_TOKEN');
    this.repoOwner = this.configService.get<string>('METADATA_REGISTRY_OWNER');
    this.repoName = this.configService.get<string>('METADATA_REGISTRY_REPO');
    this.folderName = this.configService.get<string>('METADATA_REGISTRY_FOLDER');
  }

  @Cron(CronExpression.EVERY_5_HOURS)
  async checkPendingPRs(): Promise<void> {
    this.logger.log('Checking pending token registry PRs');

    const pendingPRs = await this.tokenRegistryRepository.find({
      where: { status: TokenRegistryStatus.PENDING },
    });

    if (pendingPRs.length === 0) {
      this.logger.log('No pending PRs to check');
      return;
    }

    this.logger.log(`Found ${pendingPRs.length} pending PRs to check`);

    for (const pr of pendingPRs) {
      const updatedPR = await this.checkPRStatus(pr);

      // If PR was rejected or failed, automatically retry
      if (updatedPR.status === TokenRegistryStatus.REJECTED) {
        this.logger.log(`PR #${updatedPR.pr_number} is ${updatedPR.status}, attempting retry...`);

        // Wait a bit before retrying to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 2000));

        const retryResult = await this.retryFailedPR(updatedPR);

        if (retryResult.success) {
          this.logger.log(`Successfully retried PR #${updatedPR.pr_number}. New PR: ${retryResult.prUrl}`);
        } else {
          this.logger.warn(`Failed to retry PR #${updatedPR.pr_number}: ${retryResult.message}`);
        }
      }
    }
  }

  /**
   * Submits vault token metadata to Cardano Token Registry via GitHub PR
   * @param metadataInput Token metadata
   * @returns Submission result
   */
  async submitVaultTokenMetadata(
    metadataInput: TokenMetadataDto
  ): Promise<{ success: boolean; message: string; data?: unknown }> {
    const existingPR = await this.tokenRegistryRepository.findOne({
      where: {
        vault: { id: metadataInput.vaultId },
        status: In([TokenRegistryStatus.PENDING, TokenRegistryStatus.MERGED]),
      },
    });

    if (existingPR) {
      return { success: false, message: 'A token submission is already in progress for this vault' };
    } else {
      this.logger.log(`No existing PR found for vault ${metadataInput.vaultId}, proceeding with submission`);
    }

    const exists = await this.checkTokenExistsInRegistry(metadataInput.subject);
    if (exists) {
      return { success: false, message: 'Token already exists' };
    }

    try {
      const name = this.signMetadataField(metadataInput.subject, 0, metadataInput.name);
      const description = this.signMetadataField(metadataInput.subject, 0, metadataInput.description);

      // Optional fields
      const ticker = metadataInput.ticker
        ? this.signMetadataField(metadataInput.subject, 0, metadataInput.ticker)
        : undefined;
      const url = metadataInput.url ? this.signMetadataField(metadataInput.subject, 0, metadataInput.url) : undefined;
      // const policy = metadataInput.policy ? metadataInput.policy : undefined; // The base16-encoded CBOR "policy": "82018201828200581cf950845fdf374bba64605f96a9d5940890cc2bb92c4b5b55139cc00982051a09bde472",
      const decimals = metadataInput.decimals
        ? this.signMetadataField(metadataInput.subject, 0, metadataInput.decimals)
        : undefined;

      let logoData: ItemData | undefined;
      if (metadataInput.logo) {
        // If metadataInput.logo is a URL, convert it to byte string
        if (metadataInput.logo.startsWith('http')) {
          const logoBytes = await this.convertImageUrlToBase64(metadataInput.logo);
          logoData = this.signMetadataField(metadataInput.subject, 0, logoBytes);
        } else {
          // If it's already a byte string, use it directly
          logoData = this.signMetadataField(metadataInput.subject, 0, metadataInput.logo);
        }
      }

      // Build full metadata object
      const metadata: TokenMetaData = {
        subject: metadataInput.subject,
        // policy,
        name,
        description,
        ticker,
        url,
        logo: logoData,
        decimals,
      };

      if (!this.validateTokenMetadata(metadata)) {
        return { success: false, message: 'Invalid token metadata format' };
      }

      return await this.createMetadataRegistryPR(metadata, metadataInput.vaultId);
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof UnauthorizedException
      ) {
        throw error; // Re-throw NestJS exceptions
      }

      this.logger.error('Failed to submit token metadata:', error);
      throw new InternalServerErrorException(error.response?.data?.message || 'Failed to submit token metadata');
    }
  }

  /**
   * Checks if a token exists in the registry
   * @param subject Token identifier (policyId + assetName)
   * @returns true if token is already registered
   */
  async checkTokenExistsInRegistry(subject: string): Promise<boolean> {
    try {
      // Use authenticated Octokit to check if file exists in registry
      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({
        auth: this.githubToken,
      });

      const filePath = `registry/${subject}.json`;

      await octokit.repos.getContent({
        owner: this.repoOwner,
        repo: this.repoName,
        path: filePath,
      });

      // If we get here, file exists
      return true;
    } catch (error) {
      // If 404, token not found in registry
      if (error.status === 404) {
        return false;
      }
      this.logger.error(`Error checking token existence in registry: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check the status of a specific PR
   */
  async checkPRStatus(pr: TokenRegistry): Promise<TokenRegistry> {
    try {
      // Use authenticated Octokit for GitHub API requests
      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({
        auth: this.githubToken,
      });

      const { data: pullRequest } = await octokit.pulls.get({
        owner: this.repoOwner,
        repo: this.repoName,
        pull_number: pr.pr_number,
      });

      pr.last_checked = new Date();

      // Update status based on GitHub response
      if (pullRequest.state === 'closed') {
        if (pullRequest.merged) {
          pr.status = TokenRegistryStatus.MERGED;
          pr.merged_at = new Date(pullRequest.merged_at);
          this.logger.log(`PR #${pr.pr_number} for vault ${pr.vault_id} has been merged`);
        } else {
          pr.status = TokenRegistryStatus.REJECTED;
          this.logger.warn(`PR #${pr.pr_number} for vault ${pr.vault_id} was rejected`);
        }
      }

      // Save the updated PR record
      return this.tokenRegistryRepository.save(pr);
    } catch (error) {
      this.logger.error(`Error checking PR #${pr.pr_number} status:`, error.message);

      // If PR not found, mark as failed
      if (error.status === 404) {
        pr.status = TokenRegistryStatus.FAILED;
        return this.tokenRegistryRepository.save(pr);
      }

      // Return the PR without changes for other errors
      return pr;
    }
  }

  /**
   * Closes an open pull request on GitHub
   * @param prNumber The pull request number to close
   * @param reason Optional comment to add when closing the PR
   * @returns Object indicating success or failure
   */
  async closePullRequest(prNumber: number, reason?: string): Promise<{ success: boolean; message: string }> {
    try {
      this.logger.log(`Attempting to close PR #${prNumber}`);

      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({
        auth: this.githubToken,
      });

      const pr = await this.tokenRegistryRepository.findOne({
        where: { pr_number: prNumber },
      });

      if (!pr) {
        throw new NotFoundException(`PR #${prNumber} not found in database`);
      }

      // First, check if PR is still open
      const updatedPR = await this.checkPRStatus(pr);

      if (updatedPR.status !== TokenRegistryStatus.PENDING) {
        throw new ConflictException(`PR #${prNumber} is not open and cannot be closed`);
      }

      // Add a comment if reason is provided
      if (reason) {
        await octokit.issues.createComment({
          owner: this.repoOwner,
          repo: this.repoName,
          issue_number: prNumber,
          body: `Closing PR: ${reason}`,
        });
      }

      // Close the PR
      await octokit.pulls.update({
        owner: this.repoOwner,
        repo: this.repoName,
        pull_number: prNumber,
        state: 'closed',
      });

      // Update our database record
      updatedPR.status = TokenRegistryStatus.REJECTED;
      updatedPR.last_checked = new Date();
      await this.tokenRegistryRepository.save(updatedPR);

      this.logger.log(`Successfully closed PR #${prNumber}`);
      return { success: true, message: `PR #${prNumber} closed successfully` };
    } catch (error) {
      this.logger.error(`Failed to close PR #${prNumber}:`, error);

      // Map GitHub API errors to appropriate NestJS exceptions
      if (error.status === 401 || error.status === 403) {
        throw new UnauthorizedException(`GitHub authentication failed: ${error.message}`);
      } else if (error.status === 404) {
        throw new NotFoundException(`PR not found: ${error.message}`);
      }

      throw new InternalServerErrorException(`Failed to close PR: ${error.message}`);
    }
  }

  /**
   * Retries a failed or rejected PR by creating a new one with metadata from vault
   * @param prRecord The failed TokenRegistry record
   * @returns Object indicating success or failure
   */
  async retryFailedPR(prRecord: TokenRegistry): Promise<{ success: boolean; message: string; prUrl?: string }> {
    try {
      this.logger.log(`Retrying PR #${prRecord.pr_number} for vault ${prRecord.vault_id}`);

      // Load vault with only necessary columns
      const vault = await this.vaultRepository
        .createQueryBuilder('vault')
        .leftJoin('vault.ft_token_img', 'ft_token_img')
        .select([
          'vault.id',
          'vault.script_hash',
          'vault.asset_vault_name',
          'vault.name',
          'vault.description',
          'vault.vault_token_ticker',
          'vault.ft_token_decimals',
          'ft_token_img.file_url',
        ])
        .where('vault.id = :vaultId', { vaultId: prRecord.vault_id })
        .getOne();

      if (!vault) {
        this.logger.error(`Cannot retry PR #${prRecord.pr_number}: vault ${prRecord.vault_id} not found`);
        return {
          success: false,
          message: 'Vault not found',
        };
      }

      // Close the old PR if it's still open
      try {
        if (prRecord.status === TokenRegistryStatus.PENDING) {
          await this.closePullRequest(prRecord.pr_number, 'Retrying submission due to validation failure');
        }
      } catch (error) {
        this.logger.warn(`Could not close old PR #${prRecord.pr_number}: ${error.message}`);
        // Continue with retry even if we can't close the old PR
      }

      // Mark old record as failed before creating new one
      prRecord.status = TokenRegistryStatus.FAILED;
      await this.tokenRegistryRepository.save(prRecord);

      // Create metadata from vault data (same as in lifecycle.service.ts)
      const metadataInput: TokenMetadataDto = {
        vaultId: vault.id,
        subject: `${vault.script_hash}${vault.asset_vault_name}`,
        name: vault.name,
        description: vault.description,
        ticker: vault.vault_token_ticker,
        logo: vault.ft_token_img?.file_url || '',
        decimals: vault.ft_token_decimals,
      };

      // Submit using the same flow as initial submission
      const result = await this.submitVaultTokenMetadata(metadataInput);

      if (result.success) {
        this.logger.log(`Successfully created retry PR for vault ${prRecord.vault_id}. Old PR: #${prRecord.pr_number}`);
      }

      return result;
    } catch (error) {
      this.logger.error(`Failed to retry PR #${prRecord.pr_number}:`, error);
      return {
        success: false,
        message: `Failed to retry PR: ${error.message}`,
      };
    }
  }

  private async convertImageUrlToBase64(imgUrl: string): Promise<string> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(imgUrl, {
          responseType: 'arraybuffer',
          timeout: 10000,
          maxContentLength: 5 * 1024 * 1024,
        })
      );

      const resizedImageBuffer = await sharp(response.data)
        .resize({
          width: 128,
          height: 128,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .png({ quality: 85, compressionLevel: 9 })
        .toBuffer();

      if (resizedImageBuffer.length > 250 * 1024) {
        this.logger.warn(
          `Image still too large after resizing (${Math.round(resizedImageBuffer.length / 1024)}KB), using placeholder`
        );

        const tinyImageBuffer = await sharp(response.data)
          .resize(64, 64, { fit: 'inside' })
          .png({ quality: 60, compressionLevel: 9 })
          .toBuffer();

        if (tinyImageBuffer.length > 250 * 1024) {
          return '';
        }

        return Buffer.from(tinyImageBuffer).toString('base64');
      }

      const base64Image = Buffer.from(resizedImageBuffer).toString('base64');

      if (base64Image.length > 350 * 1024) {
        this.logger.warn(`Base64 image too large (${Math.round(base64Image.length / 1024)}KB), using placeholder`);
        return '';
      }

      return base64Image;
    } catch (error) {
      this.logger.error(`Failed to convert image to byte string: ${error.message}`);
      return '';
    }
  }

  /**
   * Validates token metadata
   * @param metadata Token metadata
   * @returns true if format is correct
   */
  private validateTokenMetadata(metadata: TokenMetaData): boolean {
    if (!metadata.subject || !metadata.name || !metadata.description) {
      this.logger.error('Required fields missing in metadata');
      return false;
    }

    // Signing check
    if (!metadata.name.signatures?.length || !metadata.description.signatures?.length) {
      this.logger.error('Signatures missing in metadata');
      return false;
    }

    return true;
  }

  /**
   * Signs a metadata field value with the admin private key
   */
  private signMetadataField(subject: string, sequenceNumber: number, value: string | number): ItemData {
    // Hash the subject, sequenceNumber, and value together
    const hash = crypto
      .createHash('sha256')
      .update(subject + sequenceNumber + value)
      .digest();

    // Sign the hash with admin private key
    const privateKey = PrivateKey.from_bech32(this.adminSKey);
    const signature = privateKey.sign(Buffer.from(hash)).to_hex();

    // Get public key in hex
    const publicKey = privateKey.to_public().to_hex();

    return {
      sequenceNumber,
      value,
      signatures: [
        {
          signature,
          publicKey,
        },
      ],
    };
  }

  /**
   * Creates a GitHub Pull Request for token metadata submission
   */
  private async createMetadataRegistryPR(
    metadata: TokenMetaData,
    vaultId: string
  ): Promise<{ success: boolean; message: string; prUrl?: string }> {
    try {
      // 1. Format metadata as JSON
      const metadataJson = JSON.stringify(metadata, null, 2);

      // 2. Create a unique branch name
      const branchName = `token-submission-${metadata.subject.substring(0, 8)}-${Date.now()}`;

      // 3. Initialize Octokit with your GitHub token
      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({
        auth: this.githubToken,
      });

      // 4. Get the authenticated user's username
      const { data: user } = await octokit.users.getAuthenticated();
      const username = user.login;

      // 5. Check if we already forked the repository
      let forked = false;
      try {
        await octokit.repos.get({
          owner: username,
          repo: this.repoName,
        });
        forked = true;
      } catch (error) {
        if (error.status === 404) {
          forked = false;
        } else {
          throw error;
        }
      }

      // 6. Create a fork if needed
      if (!forked) {
        await octokit.repos.createFork({
          owner: this.repoOwner,
          repo: this.repoName,
        });

        // Wait for the fork to be created (GitHub fork is async)
        this.logger.log('Fork created, waiting for it to be ready...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      // 7. Get the default branch of your fork
      const { data: repo } = await octokit.repos.get({
        owner: username,
        repo: this.repoName,
      });
      const defaultBranch = repo.default_branch;

      // 8. Get the latest commit SHA from your fork's default branch
      const { data: ref } = await octokit.git.getRef({
        owner: username,
        repo: this.repoName,
        // repo: 'cardano-token-registry', mainnet
        ref: `heads/${defaultBranch}`,
      });
      const sha = ref.object.sha;

      // 9. Create a new branch in your fork
      await octokit.git.createRef({
        owner: username,
        // repo: 'cardano-token-registry', mainnet
        repo: this.repoName,
        ref: `refs/heads/${branchName}`,
        sha,
      });

      // 10. Create/update the metadata file in your fork
      const filePath = `${this.folderName}/${metadata.subject}.json`;
      await octokit.repos.createOrUpdateFileContents({
        owner: username,
        repo: this.repoName,
        path: filePath,
        message: `Add token metadata for ${metadata.ticker.value}`,
        content: Buffer.from(metadataJson).toString('base64'),
        branch: branchName,
      });

      // 11. Create a pull request from your fork to the original repository
      const { data: pr } = await octokit.pulls.create({
        owner: this.repoOwner,
        repo: this.repoName,
        title: `Add token metadata for ${metadata.ticker.value}`,
        body: `This PR adds metadata for token ${metadata.ticker.value}`,
        head: `${username}:${branchName}`,
        base: defaultBranch,
      });

      // 12. Save PR information to database
      if (pr.number) {
        try {
          // Create a new TokenRegistry record
          const tokenRegistryRecord = this.tokenRegistryRepository.create({
            pr_number: pr.number,
            status: TokenRegistryStatus.PENDING,
            vault: { id: vaultId },
          });
          await this.tokenRegistryRepository.save(tokenRegistryRecord);
          this.logger.log(`Saved PR #${pr.number} information to database for vault ${vaultId}`);
        } catch (dbError) {
          this.logger.error('Failed to save PR information to database:', dbError);
          // Continue since PR was created successfully on GitHub
        }
      } else {
        this.logger.warn(`Cannot save PR to database: Missing PR number or vault ID`);
      }

      return {
        success: true,
        message: 'Pull request created successfully',
        prUrl: pr.html_url,
      };
    } catch (error) {
      this.logger.error('Failed to create token registry PR:', error);

      // Map GitHub API errors to appropriate NestJS exceptions
      if (error.status === 401 || error.status === 403) {
        throw new UnauthorizedException(`GitHub authentication failed: ${error.message}`);
      } else if (error.status === 404) {
        throw new NotFoundException(`Resource not found: ${error.message}`);
      } else if (error.status === 422) {
        throw new BadRequestException(`Validation failed: ${error.message}`);
      }

      throw new InternalServerErrorException(`Failed to create PR: ${error.message}`);
    }
  }
}
