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
import { ApiOperation, ApiResponse, ApiTags, ApiParam, ApiBody } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { TriggerHealthCheckRes } from '../offchain-tx/dto/trigger-health-check.res';
import { TransactionHealthService } from '../offchain-tx/transaction-health.service';

import { BlockchainWebhookService } from './blockchain-webhook.service';
import { BuildTransactionRes } from './dto/build-transaction.res';
import { ConfirmEvmContributionReq, PrepareEvmContributionReq } from './dto/evm-contribution.dto';
import { EvmWebhookDto } from './dto/evm-webhook.dto';
import { HandleWebhookRes } from './dto/handle-webhook.res';
import { BuildTransactionDto, SubmitTransactionDto, TransactionSubmitResponseDto } from './dto/transaction.dto';
import { BlockchainWebhookDto } from './dto/webhook.dto';
import { EvmVaultContributionService } from './evm-vault-contribution.service';
import { EvmWebhookService } from './evm-webhook.service';
import { MetadataRegistryApiService } from './metadata-register.service';
import { VaultContributionService } from './vault-contribution.service';

import { Vault } from '@/database/vault.entity';
import { AdminGuard } from '@/modules/auth/admin.guard';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { AuthRequest } from '@/modules/auth/dto/auth-user.interface';

@ApiTags('blockchain')
@Controller('blockchain')
export class BlockchainController {
  constructor(
    private readonly vaultContributionService: VaultContributionService,
    private readonly blockchainWebhookService: BlockchainWebhookService,
    private readonly evmWebhookService: EvmWebhookService,
    private readonly evmVaultContributionService: EvmVaultContributionService,
    private readonly metadataRegistryApiService: MetadataRegistryApiService,
    private readonly transactionHealthService: TransactionHealthService,
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
  async submitTransaction(@Body() params: SubmitTransactionDto): Promise<TransactionSubmitResponseDto> {
    return this.vaultContributionService.submitContributionTransaction(params);
  }

  @Post('evm/contribution/prepare')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Prepare EVM contribution — sign one ContributionAuthorization per asset',
    description:
      'Returns per-asset EIP-712 authorizations signed by the vault mintingKey, plus the vault address, chainId, and the approve/contribute calls the wallet must submit.',
  })
  async prepareEvmContribution(@Body() body: PrepareEvmContributionReq, @Request() req: AuthRequest) {
    return this.evmVaultContributionService.prepareContribution(body.txId, req.user.sub);
  }

  @Post('evm/contribution/confirm')
  @UseGuards(AuthGuard)
  @ApiOperation({
    summary: 'Confirm EVM contribution — persist tx hash and create Asset rows',
    description:
      'Called after the wallet has submitted all N on-chain contribute() calls. Stores the primary tx hash on the Transaction, records the child hashes in metadata, and materializes the Asset rows from the contribution metadata.',
  })
  async confirmEvmContribution(@Body() body: ConfirmEvmContributionReq, @Request() req: AuthRequest) {
    return this.evmVaultContributionService.confirmContribution(
      body.txId,
      body.txHash,
      req.user.sub,
      body.childTxHashes
    );
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

  @Post('evm-tx-webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Webhook endpoint for EVM (Robinhood) blockchain events via Alchemy' })
  @ApiBody({ type: EvmWebhookDto })
  @ApiResponse({
    status: 200,
    description: 'EVM blockchain event processed successfully',
    type: HandleWebhookRes,
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid webhook signature',
  })
  // NOTE: no @Body() DTO param — this route is served the raw request body as a
  // Buffer (see main.ts) so the Alchemy HMAC signature can be verified against
  // the exact bytes. The payload is parsed inside EvmWebhookService.
  async handleEvmWebhook(
    @Request() req: { headers: Record<string, string>; body: unknown }
  ): Promise<HandleWebhookRes> {
    const signatureHeader = req.headers['x-alchemy-signature'];

    // Get raw body from the request for signature verification
    let rawBody: string;
    if (Buffer.isBuffer(req.body)) {
      // If body-parser.raw() was used
      rawBody = req.body.toString('utf8');
    } else {
      // Fallback to stringifying the parsed body
      rawBody = JSON.stringify(req.body);
    }

    try {
      const details = await this.evmWebhookService.handleEvmEvent(rawBody, signatureHeader);
      return {
        status: 'success',
        details,
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
  @UseGuards(AdminGuard)
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

    // if (vault.vault_status !== VaultStatus.locked) {
    //   throw new BadRequestException(
    //     `Vault must be in locked status to submit token metadata. Current status: ${vault.vault_status}`
    //   );
    // }

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

  @Post('health-check')
  @UseGuards(AuthGuard)
  @ApiOperation({ summary: 'Manually trigger health check for stuck transactions' })
  @ApiResponse({ status: 200, description: 'Health check completed', type: TriggerHealthCheckRes })
  async triggerHealthCheck(): Promise<TriggerHealthCheckRes> {
    return this.transactionHealthService.triggerHealthCheck();
  }
}
