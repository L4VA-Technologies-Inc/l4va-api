import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsArray, IsNumber, IsOptional, ValidateNested, IsObject, IsUUID } from 'class-validator';
import { Expose, Type } from 'class-transformer';

export class AssetOutput {
  @ApiProperty({
    description: 'Amount of the asset',
    example: 1000000
  })
  @IsNumber()
  @Expose()
  readonly amount: number;
}

export class TransactionOutput {
  @ApiProperty({
    description: 'Destination address',
    example: 'addr1qy2k4r9...'
  })
  @IsString()
  @Expose()
  readonly address: string;

  @ApiProperty({
    description: 'Amount in lovelace',
    example: 1000000
  })
  @IsNumber()
  @Expose()
  readonly lovelace: number;

  @ApiProperty({
    description: 'Assets to send, keyed by asset ID',
    example: {
      'asset1abc...': 1000000
    },
    required: false
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AssetOutput)
  @Expose()
  readonly assets?: Record<string, number>;
}

export class BuildTransactionDto {
  @ApiProperty({
    description: 'Address to send change to',
    example: 'addr1qy2k4r9...'
  })
  @IsString()
  @Expose({ name: 'changeAddress' })
  readonly changeAddress: string;

  @ApiProperty({
    description: 'Outchain transaction ID (UUID)',
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  @IsUUID()
  @Expose({ name: 'txId' })
  readonly txId: string;

  @ApiProperty({
    description: 'Transaction outputs',
    type: [TransactionOutput]
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TransactionOutput)
  @Expose()
  readonly outputs: TransactionOutput[];
}

export class SubmitTransactionDto {
  @ApiProperty({
    description: 'CBOR encoded transaction',
    example: '83a400...'
  })
  @IsString()
  @Expose()
  readonly transaction: string;

  @ApiProperty({
    description: 'Array of CBOR encoded signatures',
    example: ['84a400...'],
    required: false
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Expose()
  readonly signatures?: string[];
}

export class TransactionBuildResponseDto {
  @ApiProperty({
    description: 'Transaction hash',
    example: '1234abcd...'
  })
  @Expose()
  readonly hash: string;

  @ApiProperty({
    description: 'CBOR encoded complete transaction',
    example: '83a400...'
  })
  @Expose()
  readonly complete: string;

  @ApiProperty({
    description: 'CBOR encoded stripped transaction',
    example: '83a400...'
  })
  @Expose()
  readonly stripped: string;

  @ApiProperty({
    description: 'CBOR encoded witness set',
    example: '83a400...'
  })
  @Expose()
  readonly witnessSet: string;
}

export class TransactionSubmitResponseDto {
  @ApiProperty({
    description: 'Transaction hash',
    example: '1234abcd...'
  })
  @Expose({ name: 'txHash' })
  readonly txHash: string;
}
