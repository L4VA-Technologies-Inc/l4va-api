import {
  Body,
  Controller,
  Post,
  UseGuards,
  HttpCode,
  Request,
  Param,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags, ApiParam } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BlockchainWebhookService } from './blockchain-webhook.service';
import { BuildTransactionRes } from './dto/build-transaction.res';
import { HandleWebhookRes } from './dto/handle-webhook.res';
import { BuildTransactionDto, SubmitTransactionDto, TransactionSubmitResponseDto } from './dto/transaction.dto';
import { BlockchainWebhookDto } from './dto/webhook.dto';
import { MetadataRegistryApiService } from './metadata-register.service';
import { VaultContributionService } from './vault-contribution.service';

import { Vault } from '@/database/vault.entity';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';
import { VaultStatus } from '@/types/vault.types';

@ApiTags('blockchain')
@Controller('blockchain')
export class BlockchainController {
  constructor(
    private readonly vaultContributionService: VaultContributionService,
    private readonly blockchainWebhookService: BlockchainWebhookService,
    private readonly metadataRegistryApiService: MetadataRegistryApiService,
    @InjectRepository(Vault)
    private readonly vaultRepository: Repository<Vault>
  ) {}

  @Post('transaction/build')
  @ApiOperation({ summary: 'Build a Cardano transaction' })
  @ApiResponse({
    status: 200,
    description: 'Transaction built successfully',
    type: BuildTransactionRes,
  })
  @UseGuards(AuthGuard)
  async buildTransaction(@Body() params: BuildTransactionDto): Promise<BuildTransactionRes> {
    return this.vaultContributionService.buildContributionTransaction(params);
  }

  @Post('transaction/submit')
  @ApiOperation({ summary: 'Submit a signed Cardano transaction' })
  @ApiResponse({
    status: 200,
    description: 'Transaction submitted successfully',
    type: TransactionSubmitResponseDto,
  })
  @UseGuards(AuthGuard)
  async submitTransaction(
    @Request() req: AuthRequest,
    @Body() params: SubmitTransactionDto
  ): Promise<TransactionSubmitResponseDto> {
    return this.vaultContributionService.submitContributionTransaction(params);
  }

  @Post('tx-webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Webhook endpoint for blockchain events' })
  @ApiResponse({
    status: 200,
    description: 'Blockchain event processed successfully',
    type: HandleWebhookRes,
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid webhook signature',
  })
  async handleWebhook(
    @Body() event: BlockchainWebhookDto,
    @Request() req: { headers: Record<string, string>; body: unknown }
  ): Promise<HandleWebhookRes> {
    const signatureHeader = req.headers['blockfrost-signature'];

    // Get raw body from the request
    let rawBody: string;
    if (Buffer.isBuffer(req.body)) {
      // If body-parser.raw() was used
      rawBody = req.body.toString('utf8');
    } else {
      // Fallback to stringifying the parsed body
      rawBody = JSON.stringify(req.body);
    }

    try {
      const updatedLocalTxIds = await this.blockchainWebhookService.handleBlockchainEvent(rawBody, signatureHeader);

      const txSummary = event.payload.map(txEvent => ({
        txHash: txEvent.tx.hash,
        updatedLocalTxIds,
      }));

      return {
        status: 'success',
        details: txSummary,
      };
    } catch (error) {
      return {
        status: 'error',
        details: error.message,
      };
    }
  }

  @Post('vault/:vaultId/submit-token-metadata')
  @ApiOperation({
    summary: 'Manually submit token metadata PR for a locked vault',
    description:
      'Creates a GitHub PR to register the vault token in the Cardano Token Registry. Only works for vaults in locked status that do not have an existing PR.',
  })
  @ApiParam({ name: 'vaultId', description: 'The UUID of the vault' })
  @ApiResponse({
    status: 200,
    description: 'Token metadata PR submitted successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Vault is not locked or already has a pending/merged PR',
  })
  @ApiResponse({
    status: 404,
    description: 'Vault not found',
  })
  @UseGuards(AuthGuard)
  async submitTokenMetadata(
    @Param('vaultId') vaultId: string
  ): Promise<{ success: boolean; message: string; prUrl?: string }> {
    const vault = await this.vaultRepository.findOne({
      where: { id: vaultId },
      select: ['id', 'vault_status'],
    });

    if (!vault) {
      throw new NotFoundException(`Vault ${vaultId} not found`);
    }

    if (vault.vault_status !== VaultStatus.locked) {
      throw new BadRequestException(
        `Vault must be in locked status to submit token metadata. Current status: ${vault.vault_status}`
      );
    }

    const result = await this.metadataRegistryApiService.submitVaultTokenMetadata(vaultId);

    if (!result.success) {
      throw new BadRequestException(result.message);
    }

    return {
      success: result.success,
      message: result.message,
      prUrl: (result.data as { prUrl?: string })?.prUrl,
    };
  }
}
