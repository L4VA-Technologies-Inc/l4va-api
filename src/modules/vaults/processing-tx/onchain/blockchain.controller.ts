import { Body, Controller, Post, UseGuards, HttpCode, Request } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { BlockchainWebhookService } from './blockchain-webhook.service';
import {
  BuildTransactionDto,
  SubmitTransactionDto,
  TransactionBuildResponseDto,
  TransactionSubmitResponseDto,
} from './dto/transaction.dto';
import { BlockchainWebhookDto } from './dto/webhook.dto';
import { VaultContributionService } from './vault-contribution.service';

import { AuthGuard } from '@/modules/auth/auth.guard';

@ApiTags('blockchain')
@Controller('blockchain')
export class BlockchainController {
  constructor(
    private readonly vaultContributionService: VaultContributionService,
    private readonly blockchainWebhookService: BlockchainWebhookService
  ) {}

  @Post('transaction/build')
  @ApiOperation({ summary: 'Build a Cardano transaction' })
  @ApiResponse({
    status: 200,
    description: 'Transaction built successfully',
    type: TransactionBuildResponseDto,
  })
  @UseGuards(AuthGuard)
  async buildTransaction(@Body() params: BuildTransactionDto): Promise<{
    presignedTx: string;
  }> {
    return this.vaultContributionService.buildTransaction(params);
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
    return this.vaultContributionService.submitTransaction(params);
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
  async handleWebhook(
    @Body() event: BlockchainWebhookDto,
    @Request() req: { headers: Record<string, string>; body: unknown }
  ): Promise<{ status: string; details: any }> {
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

    // Process the event with signature verification
    try {
      const updatedLocalTxIds = await this.blockchainWebhookService.handleBlockchainEvent(rawBody, signatureHeader);

      // Return transaction summary
      const txSummary = event.payload.map(txEvent => ({
        txHash: txEvent.tx.hash,
        updatedLocalTxIds,
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
