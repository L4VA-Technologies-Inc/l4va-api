import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { IsArray, IsNumber, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';

export class BlockfrostAmount {
  @ApiProperty({
    description: 'The unit of the value',
    example: 'lovelace',
  })
  @IsString()
  @Expose()
  unit: string;

  @ApiProperty({
    description: 'The quantity of the unit',
    example: '1664454750',
  })
  @IsString()
  @Expose()
  quantity: string;
}

export class BlockfrostTxInput {
  @ApiProperty({
    description: 'Input address',
    example: 'addr1q8suxg555ynm66ykapc2999hzyxnmre70xf6p20pa2z269agynrj803a45k5zqg2usxju3wk5gywqjdtd59salr9mpzq9g4r8a',
  })
  @IsString()
  @Expose()
  address: string;

  @ApiProperty({
    description: 'Input amounts',
    type: [BlockfrostAmount],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BlockfrostAmount)
  @Expose()
  amount: BlockfrostAmount[];

  @ApiProperty({
    description: 'Hash of the transaction',
    example: 'c4ca612037927bb6276a3742ce7ecadbaa18c91f1c756563f63dc10c8d03ef75',
  })
  @IsString()
  @Expose()
  tx_hash: string;

  @ApiProperty({
    description: 'Index of the output',
    example: 0,
  })
  @IsNumber()
  @Expose()
  output_index: number;

  @ApiProperty({
    description: 'Whether this is a collateral input',
    example: false,
  })
  @IsOptional()
  @Expose()
  collateral?: boolean;

  @ApiProperty({
    description: 'The hash of the transaction data',
    example: null,
  })
  @IsOptional()
  @Expose()
  data_hash?: string | null;
}

export class BlockfrostTxOutput {
  @ApiProperty({
    description: 'Output address',
    example: 'addr1q9zyjm3lkfjhgt2g6cyqts8kpwppl3l5ud8afpgqxzygrhgv45sex0xp482gdrnnkzdlajwc9zalzx8zvcvum2qvkqzsln7sdv',
  })
  @IsString()
  @Expose()
  address: string;

  @ApiProperty({
    description: 'Output amounts',
    type: [BlockfrostAmount],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BlockfrostAmount)
  @Expose()
  amount: BlockfrostAmount[];

  @ApiProperty({
    description: 'Index of the output',
    example: 0,
  })
  @IsNumber()
  @Expose()
  output_index: number;

  @ApiProperty({
    description: 'The hash of the transaction data',
    example: null,
  })
  @IsOptional()
  @Expose()
  data_hash?: string | null;
}

export class BlockfrostTransaction {
  @ApiProperty({
    description: 'Transaction hash',
    example: '9358fccf785f40d5507ed81b38f16b03148baf341e1de4d511689eebb436dd4b',
  })
  @IsString()
  @Expose()
  hash: string;

  @ApiProperty({
    description: 'Block hash',
    example: '3e0f394b2601b99b26761bbceab1063bc7fa29578165cd840c3dee6d286e98be',
  })
  @IsString()
  @Expose()
  block: string;

  @ApiProperty({
    description: 'Block number',
    example: 7012249,
  })
  @IsNumber()
  @Expose()
  block_height: number;

  @ApiProperty({
    description: 'Block creation time',
    example: 1647611205,
  })
  @IsNumber()
  @Expose()
  block_time: number;

  @ApiProperty({
    description: 'Slot number',
    example: 56044914,
  })
  @IsNumber()
  @Expose()
  slot: number;

  @ApiProperty({
    description: 'Transaction index within the block',
    example: 0,
  })
  @IsNumber()
  @Expose()
  index: number;

  @ApiProperty({
    description: 'Output amounts',
    type: [BlockfrostAmount],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BlockfrostAmount)
  @Expose()
  output_amount: BlockfrostAmount[];

  @ApiProperty({
    description: 'Fees for the transaction',
    example: '174345',
  })
  @IsString()
  @Expose()
  fees: string;

  @ApiProperty({
    description: 'Deposit',
    example: '0',
  })
  @IsString()
  @Expose()
  deposit: string;

  @ApiProperty({
    description: 'Size in bytes',
    example: 426,
  })
  @IsNumber()
  @Expose()
  size: number;

  @ApiProperty({
    description: 'Invalid before slot',
    example: null,
  })
  @IsOptional()
  @Expose()
  invalid_before: number | null;

  @ApiProperty({
    description: 'Invalid after slot',
    example: 56051594,
  })
  @IsOptional()
  @Expose()
  invalid_hereafter: number | null;

  @ApiProperty({
    description: 'Count of UTXOs',
    example: 4,
  })
  @IsNumber()
  @Expose()
  utxo_count: number;

  @ApiProperty({
    description: 'Count of withdrawals',
    example: 0,
  })
  @IsNumber()
  @Expose()
  withdrawal_count: number;

  @ApiProperty({
    description: 'Count of MIR certificates',
    example: 0,
  })
  @IsNumber()
  @Expose()
  mir_cert_count: number;

  @ApiProperty({
    description: 'Count of delegations',
    example: 0,
  })
  @IsNumber()
  @Expose()
  delegation_count: number;

  @ApiProperty({
    description: 'Count of stake certificates',
    example: 0,
  })
  @IsNumber()
  @Expose()
  stake_cert_count: number;

  @ApiProperty({
    description: 'Count of pool updates',
    example: 0,
  })
  @IsNumber()
  @Expose()
  pool_update_count: number;

  @ApiProperty({
    description: 'Count of pool retirements',
    example: 0,
  })
  @IsNumber()
  @Expose()
  pool_retire_count: number;

  @ApiProperty({
    description: 'Count of asset mint or burn events',
    example: 0,
  })
  @IsNumber()
  @Expose()
  asset_mint_or_burn_count: number;

  @ApiProperty({
    description: 'Count of redeemers',
    example: 0,
  })
  @IsNumber()
  @Expose()
  redeemer_count: number;

  @ApiProperty({
    description: 'Whether the contract is valid',
    example: true,
  })
  @IsOptional()
  @Expose()
  valid_contract?: boolean;
}

export class BlockfrostTransactionEvent {
  @ApiProperty({
    description: 'Transaction details',
    type: BlockfrostTransaction,
  })
  @IsObject()
  @ValidateNested()
  @Type(() => BlockfrostTransaction)
  @Expose()
  tx: BlockfrostTransaction;

  @ApiProperty({
    description: 'Transaction inputs',
    type: [BlockfrostTxInput],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BlockfrostTxInput)
  @Expose()
  inputs: BlockfrostTxInput[];

  @ApiProperty({
    description: 'Transaction outputs',
    type: [BlockfrostTxOutput],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BlockfrostTxOutput)
  @Expose()
  outputs: BlockfrostTxOutput[];
}

export class BlockchainWebhookDto {
  @ApiProperty({
    description: 'Unique identifier of the webhook request',
    example: 'cd153e0a-2561-4761-9fa1-98b62937438e',
  })
  @IsString()
  @Expose()
  id: string;

  @ApiProperty({
    description: 'Identifier of the Webhook',
    example: 'cf68eb9c-635f-415e-a5a8-6233638f28d6',
  })
  @IsString()
  @Expose()
  webhook_id: string;

  @ApiProperty({
    description: 'Unix timestamp when the event was detected',
    example: 1647611209,
  })
  @IsNumber()
  @Expose()
  created: number;

  @ApiProperty({
    description: 'Version of Event objects',
    example: 1,
  })
  @IsNumber()
  @Expose()
  api_version: number;

  @ApiProperty({
    description: 'Type of the event',
    example: 'transaction',
  })
  @IsString()
  @Expose()
  type: string;

  @ApiProperty({
    description: 'Array of transaction events',
    type: [BlockfrostTransactionEvent],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BlockfrostTransactionEvent)
  @Expose()
  payload: BlockfrostTransactionEvent[];
}
