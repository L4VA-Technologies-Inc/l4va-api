import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { IsArray, IsNumber, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';

export class EvmAddress {
  @ApiProperty({
    description: 'EVM address',
    example: '0x9c683965ed397da89acfe21ea81b166a41fef889',
  })
  @IsString()
  @IsOptional()
  @Expose()
  address?: string;
}

export class EvmWebhookTransaction {
  @ApiProperty({
    description: 'Transaction hash',
    example: '0xb821ac30739de0a987d36358d316ad1a86ceb4dd20cee4cc05e00e0d09855b89',
  })
  @IsString()
  @Expose()
  hash: string;

  @ApiProperty({ description: 'Transaction nonce', example: 5 })
  @IsNumber()
  @IsOptional()
  @Expose()
  nonce?: number;

  @ApiProperty({ description: 'Transaction index within the block', example: 0 })
  @IsNumber()
  @IsOptional()
  @Expose()
  index?: number;

  @ApiProperty({ description: 'Sender of the transaction', type: EvmAddress })
  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => EvmAddress)
  @Expose()
  from?: EvmAddress;

  @ApiProperty({ description: 'Recipient of the transaction', type: EvmAddress })
  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => EvmAddress)
  @Expose()
  to?: EvmAddress;

  @ApiProperty({ description: 'Transferred value (wei)', example: '0' })
  @IsString()
  @IsOptional()
  @Expose()
  value?: string;

  @ApiProperty({ description: 'Gas price (hex)', example: '0x5a00c580' })
  @IsString()
  @IsOptional()
  @Expose()
  gasPrice?: string;

  @ApiProperty({ description: 'Max fee per gas (hex)', example: '0x5a00c580' })
  @IsString()
  @IsOptional()
  @Expose()
  maxFeePerGas?: string;

  @ApiProperty({ description: 'Max priority fee per gas (hex)', example: '0x0' })
  @IsString()
  @IsOptional()
  @Expose()
  maxPriorityFeePerGas?: string;

  @ApiProperty({ description: 'Gas limit', example: '0x5208' })
  @IsString()
  @IsOptional()
  @Expose()
  gas?: string;

  @ApiProperty({
    description: 'Transaction receipt status (1 = success, 0 = reverted)',
    example: 1,
  })
  @IsNumber()
  @Expose()
  status: number;

  @ApiProperty({ description: 'Gas used by the transaction', example: '0x5208' })
  @IsString()
  @IsOptional()
  @Expose()
  gasUsed?: string;

  @ApiProperty({ description: 'Cumulative gas used in the block', example: '0x5208' })
  @IsString()
  @IsOptional()
  @Expose()
  cumulativeGasUsed?: string;

  @ApiProperty({ description: 'Effective gas price (hex)', example: '0x989680' })
  @IsString()
  @IsOptional()
  @Expose()
  effectiveGasPrice?: string;

  @ApiProperty({
    description: 'Contract created by this transaction, if any',
    type: EvmAddress,
  })
  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => EvmAddress)
  @Expose()
  createdContract?: EvmAddress;
}

export class EvmWebhookLog {
  @ApiProperty({
    description: 'ABI-encoded non-indexed event data',
    example: '0x0000000000000000000000000000000000000000000000000000000000000001',
  })
  @IsString()
  @IsOptional()
  @Expose()
  data?: string;

  @ApiProperty({
    description: 'Event topics (topic0 is the event signature hash)',
    type: [String],
    example: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
  })
  @IsArray()
  @IsOptional()
  @Expose()
  topics?: string[];

  @ApiProperty({ description: 'Log index within the block', example: 0 })
  @IsNumber()
  @IsOptional()
  @Expose()
  index?: number;

  @ApiProperty({
    description: 'Contract account that emitted the log',
    type: EvmAddress,
  })
  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => EvmAddress)
  @Expose()
  account?: EvmAddress;

  @ApiProperty({
    description: 'Transaction that produced this log',
    type: EvmWebhookTransaction,
  })
  @IsObject()
  @ValidateNested()
  @Type(() => EvmWebhookTransaction)
  @Expose()
  transaction: EvmWebhookTransaction;
}

export class EvmWebhookBlock {
  @ApiProperty({
    description: 'Block hash',
    example: '0x53c40891eb673dbaa4d8915a0e9ad0d07b2bcfbc117ebc505ad027c4e10a0450',
  })
  @IsString()
  @Expose()
  hash: string;

  @ApiProperty({
    description: 'Block number',
    example: 91746249,
  })
  @IsNumber()
  @Expose()
  number: number;

  @ApiProperty({
    description: 'Block timestamp (unix seconds)',
    example: 1784556680,
  })
  @IsNumber()
  @Expose()
  timestamp: number;

  @ApiProperty({
    description: 'Event logs emitted by the watched contract(s) in this block',
    type: [EvmWebhookLog],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EvmWebhookLog)
  @Expose()
  logs: EvmWebhookLog[];
}

export class EvmWebhookData {
  @ApiProperty({
    description: 'Block data',
    type: EvmWebhookBlock,
  })
  @IsObject()
  @ValidateNested()
  @Type(() => EvmWebhookBlock)
  @Expose()
  block: EvmWebhookBlock;
}

export class EvmWebhookEvent {
  @ApiProperty({
    description: 'GraphQL query result',
    type: EvmWebhookData,
  })
  @IsObject()
  @ValidateNested()
  @Type(() => EvmWebhookData)
  @Expose()
  data: EvmWebhookData;

  @ApiProperty({
    description: 'Sequence number of the event',
    example: '10000000000578619000',
  })
  @IsString()
  @IsOptional()
  @Expose()
  sequenceNumber?: string;

  @ApiProperty({
    description: 'Network the event originates from',
    example: 'ROBINHOOD_TESTNET',
  })
  @IsString()
  @IsOptional()
  @Expose()
  network?: string;
}

export class EvmWebhookDto {
  @ApiProperty({
    description: 'Identifier of the webhook configuration',
    example: 'wh_8k7b4foanb86hwdy',
  })
  @IsString()
  @Expose()
  webhookId: string;

  @ApiProperty({
    description: 'Unique identifier of this webhook event',
    example: 'whevt_hq0s38l4elyqe1hu',
  })
  @IsString()
  @Expose()
  id: string;

  @ApiProperty({
    description: 'ISO timestamp when the event was created',
    example: '2026-07-20T14:11:20.834641407Z',
  })
  @IsString()
  @IsOptional()
  @Expose()
  createdAt?: string;

  @ApiProperty({
    description: 'Type of the webhook (Alchemy custom GraphQL webhook)',
    example: 'GRAPHQL',
  })
  @IsString()
  @Expose()
  type: string;

  @ApiProperty({
    description: 'Webhook event payload',
    type: EvmWebhookEvent,
  })
  @IsObject()
  @ValidateNested()
  @Type(() => EvmWebhookEvent)
  @Expose()
  event: EvmWebhookEvent;
}
