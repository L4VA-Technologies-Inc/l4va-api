import { Body, Controller, Post, UseGuards, HttpCode, Request, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  BuildTransactionDto,
  SubmitTransactionDto,
  TransactionBuildResponseDto,
  TransactionSubmitResponseDto,
} from './dto/transaction.dto';
import { BlockchainWebhookDto } from './dto/webhook.dto';
import { VaultInsertingService } from './vault-inserting.service';
import { VaultConfig, VaultManagingService } from './vault-managing.service';
import { WebhookVerificationService } from './webhook-verification.service';

import { AuthGuard } from '@/modules/auth/auth.guard';

@ApiTags('blockchain')
@Controller('blockchain')
export class BlockchainController {
  constructor(
    private readonly transactionService: VaultInsertingService,
    private readonly webhookVerificationService: WebhookVerificationService,
    private readonly vaultManagingService: VaultManagingService
  ) {}

  @Post('transaction/build')
  @ApiOperation({ summary: 'Build a Cardano transaction' })
  @ApiResponse({
    status: 200,
    description: 'Transaction built successfully',
    type: TransactionBuildResponseDto,
  })
  @UseGuards(AuthGuard)
  async buildTransaction(@Body() params: BuildTransactionDto): Promise<TransactionBuildResponseDto> {
    return this.transactionService.buildTransaction(params);
  }
  @Post('burn-vault')
  @ApiOperation({ summary: 'Build a Cardano transaction for burn vault' })
  @ApiResponse({
    status: 200,
    description: 'Transaction built successfully',
    type: TransactionBuildResponseDto,
  })
  @UseGuards(AuthGuard)
  async burnVault(@Request() req, @Body() data: any): Promise<any> {
    const userId = req.user.sub;
    return this.transactionService.handleBurnVault(userId, data.vaultId);
  }

  @Post('vault/update')
  @ApiOperation({ summary: 'Update vault metadata' })
  @ApiResponse({
    status: 200,
    description: 'Vault updated successfully',
    type: Object,
  })
  @UseGuards(AuthGuard)
  async updateVaultMetadata(@Body() params: VaultConfig) {
    return this.vaultManagingService.updateVaultMetadataTx(params);
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
    return this.transactionService.submitTransaction(params);
  }

  @Post('scanner-wh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Webhook endpoint for scanner events' })
  @ApiResponse({
    status: 200,
    description: 'Blockchain event processed successfully',
    type: Object,
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid webhook signature',
  })
  async scannerWh(@Body() event: any, @Request() _req) {
    try {
      await this.transactionService.handleScannerEvent(event);

      return {
        status: 'success',
        details: 'txSummary',
      };
    } catch (error) {
      console.error('Error processing webhook:', error);
      return {
        status: 'error',
        details: error.message,
      };
    }
  }

  @Post('tx-webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Webhook endpoint for blockchain events' })
  @ApiResponse({
    status: 200,
    description: 'Blockchain event processed successfully',
    type: Object,
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid webhook signature',
  })
  async handleWebhook(@Body() event: BlockchainWebhookDto, @Request() req): Promise<{ status: string; details: any }> {
    const signature = req.headers['blockfrost-signature'];

    // Get raw body from the request
    let rawBody: string;
    if (Buffer.isBuffer(req.body)) {
      // If body-parser.raw() was used
      rawBody = req.body.toString('utf8');
      // Parse the raw body into our DTO
      event = JSON.parse(rawBody);
    } else {
      // Fallback to stringifying the parsed body
      rawBody = JSON.stringify(req.body);
    }

    // Log headers and event info for debugging
    console.log('Received webhook event:', {
      signature,
      timestamp: req.headers['blockfrost-timestamp'],
      eventId: event.id,
      webhookId: event.webhook_id,
      rawBodyLength: rawBody.length,
      rawBodyPreview: rawBody.substring(0, 100) + '...',
    });

    // Verify webhook signature using the raw body
    const isValid = this.webhookVerificationService.verifySignature(rawBody, signature);
    if (!isValid) {
      console.error('Webhook signature verification failed:', {
        signature,
        eventId: event.id,
        webhookId: event.webhook_id,
        rawBodyPreview: rawBody.substring(0, 100) + '...',
      });
      throw new UnauthorizedException('Invalid webhook signature');
    }

    // Process the event
    try {
      await this.transactionService.handleBlockchainEvent(event);

      // Return transaction summary
      const txSummary = event.payload.map(txEvent => ({
        txHash: txEvent.tx.hash,
        blockHeight: txEvent.tx.block_height,
        timestamp: txEvent.tx.block_time,
        status: txEvent.tx.valid_contract ? 'confirmed' : 'failed',
        transfers: txEvent.outputs.map(output => ({
          recipient: output.address,
          assets: output.amount.map(asset => ({
            unit: asset.unit,
            quantity: asset.quantity,
            type: asset.unit === 'lovelace' ? 'ADA' : asset.quantity === '1' ? 'NFT' : 'TOKEN',
          })),
        })),
      }));

      return {
        status: 'success',
        details: txSummary,
      };
    } catch (error) {
      console.error('Error processing webhook:', error);
      return {
        status: 'error',
        details: error.message,
      };
    }
  }
}
