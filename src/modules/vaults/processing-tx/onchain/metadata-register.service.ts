import { Buffer } from 'buffer';
import * as crypto from 'crypto';

import { PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

type ItemData = {
  sequenceNumber: number;
  value: string;
  signatures: {
    signature: string;
    publicKey: string;
  }[];
}; //

type TokenMetaData = {
  subject: string; //	The base16-encoded policyId + base16-encoded assetName
  policy: string; // The base16-encoded CBOR representation of the monetary policy script, used to verify ownership. Optional in the case of Plutus scripts as verification is handled elsewhere.
  name: ItemData; // A human-readable name for the subject, suitable for use in an interface
  description: ItemData; // A human-readable description for the subject, suitable for use in an interface
  ticker?: ItemData; // A human-readable ticker name for the subject, suitable for use in an interface
  url?: ItemData; // A HTTPS URL (web page relating to the token)
  logo?: ItemData; // A PNG image file as a byte string
  decimals?: ItemData; // how many decimals to the token
};

export type TokenMetaDataRaw = {
  subject: string; //	The base16-encoded policyId + base16-encoded assetName
  policy: string; // The base16-encoded CBOR representation of the monetary policy script, used to verify ownership. Optional in the case of Plutus scripts as verification is handled elsewhere.
  name: string; // A human-readable name for the subject, suitable for use in an interface
  description: string; // A human-readable description for the subject, suitable for use in an interface
  ticker?: string; // A human-readable ticker name for the subject, suitable for use in an interface
  url?: string; // A HTTPS URL (web page relating to the token)
  logo?: string; // A PNG image file as a byte string
  decimals?: number; // how many decimals to the token
};

@Injectable()
export class MetadataRegistryApiService {
  private readonly apiBaseUrl: string;
  private readonly adminSKey: string;
  private readonly githubToken: string;
  private readonly repoOwner: string;
  private readonly repoName: string;

  constructor(private readonly configService: ConfigService) {
    this.adminSKey = this.configService.get<string>('ADMIN_S_KEY');
    this.githubToken = this.configService.get<string>('GITHUB_TOKEN');
    this.apiBaseUrl = this.configService.get<string>('METADATA_API_TESTNET_URL');
    this.repoOwner = this.configService.get<string>('METADATA_REGISTRY_TESTNET_OWNER');
    this.repoName = this.configService.get<string>('METADATA_REGISTRY_TESTNET_REPO');
  }

  /**
   * Відправляє метадані токена через API
   * @param metadata Метадані токена
   * @returns Результат відправки
   */
  async submitTokenMetadata(raw: TokenMetaDataRaw): Promise<{ success: boolean; message: string; data?: unknown }> {
    try {
      const exists = await this.checkTokenExists(raw.subject);
      if (exists) {
        return { success: false, message: 'Token already exists' };
      }
      console.log('Token does not exist, proceeding with submission');
    } catch (error) {
      console.error('Error checking token existence:', error);
    }

    try {
      const name = this.signItemData(raw.subject, 0, raw.name);
      const description = this.signItemData(raw.subject, 0, raw.description);

      // Optional fields
      const ticker = raw.ticker ? this.signItemData(raw.subject, 0, raw.ticker) : undefined;
      const url = raw.url ? this.signItemData(raw.subject, 0, raw.url) : undefined;
      const logo = raw.logo ? this.signItemData(raw.subject, 0, raw.logo) : undefined;
      const decimals =
        typeof raw.decimals === 'number' ? this.signItemData(raw.subject, 0, raw.decimals.toString()) : undefined;

      // Build full metadata object
      const metadata: TokenMetaData = {
        subject: raw.subject,
        policy: raw.policy,
        name,
        description,
        ticker,
        url,
        logo,
        decimals,
      };

      // Валідація метаданих перед відправкою
      if (!this.validateTokenMetadata(metadata)) {
        return { success: false, message: 'Invalid token metadata format' };
      }

      // Відправка метаданих
      const result = await this.createTokenRegistryPR(metadata);

      return result;
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof UnauthorizedException
      ) {
        throw error; // Re-throw NestJS exceptions
      }

      console.error('Failed to submit token metadata:', error);
      throw new InternalServerErrorException(error.response?.data?.message || 'Failed to submit token metadata');
    }
  }

  /**
   * Перевіряє наявність токена в реєстрі
   * @param subject Ідентифікатор токена (policyId + assetName)
   * @returns true, якщо токен вже зареєстрований
   */
  async checkTokenExists(subject: string): Promise<boolean> {
    try {
      const response = await axios.get(`${this.apiBaseUrl}/${subject}`);
      return response.status === 200;
    } catch (error) {
      // Якщо отримали 404, токен не знайдено
      if (error.response?.status === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Валідує метадані токена
   * @param metadata Метадані токена
   * @returns true, якщо формат коректний
   */
  private validateTokenMetadata(metadata: TokenMetaData): boolean {
    // Перевірка обов'язкових полів
    if (!metadata.subject || !metadata.name || !metadata.description) {
      console.error('Required fields missing in metadata');
      return false;
    }

    // Перевірка підписів
    if (!metadata.name.signatures?.length || !metadata.description.signatures?.length) {
      console.error('Signatures missing in metadata');
      return false;
    }

    // Додаткові перевірки можна додати за потреби
    return true;
  }

  private signItemData(subject: string, sequenceNumber: number, value: string): ItemData {
    // Hash the subject, sequenceNumber, and value together
    const hash = crypto
      .createHash('sha256')
      .update(subject + sequenceNumber + value)
      .digest();

    // Sign the hash with admin private key
    const privateKey = PrivateKey.from_bech32(this.adminSKey);
    const signature = privateKey.sign(Buffer.from(hash)).to_hex();

    // Get public key in hex
    const publicKey = privateKey.to_public().to_bech32();

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

  private async createTokenRegistryPR(
    metadata: TokenMetaData
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
        console.log('Fork created, waiting for it to be ready...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }

      // 7. Get the default branch of your fork
      const { data: repo } = await octokit.repos.get({
        owner: username,
        repo: 'cardano-token-registry',
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
      const filePath = `registry/${metadata.subject}.json`;
      await octokit.repos.createOrUpdateFileContents({
        owner: username,
        repo: this.repoName,
        path: filePath,
        message: `Add token metadata for ${metadata.name.value}`,
        content: Buffer.from(metadataJson).toString('base64'),
        branch: branchName,
      });

      // 11. Create a pull request from your fork to the original repository
      const { data: pr } = await octokit.pulls.create({
        owner: this.repoOwner,
        repo: this.repoName,
        title: `Add token metadata for ${metadata.name.value}`,
        body: `This PR adds metadata for token ${metadata.name.value} (${metadata.ticker?.value || ''})`,
        head: `${username}:${branchName}`,
        base: defaultBranch,
      });

      return {
        success: true,
        message: 'Pull request created successfully',
        prUrl: pr.html_url,
      };
    } catch (error) {
      console.error('Failed to create token registry PR:', error);

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
