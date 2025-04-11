import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { BlockchainTransactionService } from './blockchain-transaction.service';
import { AuthGuard } from '../auth/auth.guard';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  BuildTransactionDto,
  SubmitTransactionDto,
  TransactionBuildResponseDto,
  TransactionSubmitResponseDto
} from './dto/transaction.dto';

@ApiTags('blockchain')
@Controller('blockchain')
export class BlockchainController {
  constructor(
    private readonly transactionService: BlockchainTransactionService,
  ) {}

  @Post('transaction/build')
  @ApiOperation({ summary: 'Build a Cardano transaction' })
  @ApiResponse({
    status: 200,
    description: 'Transaction built successfully',
    type: TransactionBuildResponseDto
  })
  @UseGuards(AuthGuard)
  async buildTransaction(@Body() params: BuildTransactionDto): Promise<TransactionBuildResponseDto> {
    return this.transactionService.buildTransaction(params);
  }

  @Post('transaction/submit')
  @ApiOperation({ summary: 'Submit a signed Cardano transaction' })
  @ApiResponse({
    status: 200,
    description: 'Transaction submitted successfully',
    type: TransactionSubmitResponseDto
  })
  @UseGuards(AuthGuard)
  async submitTransaction(@Body() params: SubmitTransactionDto): Promise<TransactionSubmitResponseDto> {
    return this.transactionService.submitTransaction(params);
  }
}
