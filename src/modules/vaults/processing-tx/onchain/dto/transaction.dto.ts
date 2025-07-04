import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { IsString, IsArray, IsNumber, IsOptional, ValidateNested, IsUUID, IsNotEmpty } from 'class-validator';

export class NftAsset {
  @ApiProperty({
    description: 'Policy ID of the NFT',
    example: '47642adf3fb7154f0880b916bc341aafa0fcdf1d49f67eac856987a2',
  })
  @IsString()
  @Expose()
  readonly policyId: string;

  @ApiProperty({
    description: 'Asset name',
    example: 'l4vaaudiEngine',
  })
  @IsString()
  @Expose()
  readonly assetName: string;

  @ApiProperty({
    description: 'Quantity of the asset',
    example: 1,
  })
  @IsNumber()
  @Expose()
  readonly quantity: number;
}

export class TransactionOutput {
  @ApiProperty({
    description: 'Destination address',
    example: 'addr1qy2k4r9...',
  })
  @Expose()
  readonly address?: string;

  @ApiProperty({
    description: 'Amount in lovelace (can be combined with NFT assets)',
    example: 1000000,
    required: false,
    type: Number,
  })
  @IsOptional()
  @IsNumber()
  @Expose()
  readonly lovelace?: number;

  @ApiProperty({
    description: 'NFT assets to send (can be combined with lovelace)',
    type: [NftAsset],
    required: false,
    example: [
      {
        policyId: '47642adf3fb7154f0880b916bc341aafa0fcdf1d49f67eac856987a2',
        assetName: 'l4vaaudiEngine',
        quantity: 1,
      },
    ],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NftAsset)
  @Expose()
  readonly assets?: NftAsset[];
}

export class BuildTransactionDto {
  @ApiProperty({
    description: 'Address to send change to',
    example: 'addr1qy2k4r9...',
  })
  @IsString()
  @Expose({ name: 'changeAddress' })
  readonly changeAddress: string;

  @ApiProperty({
    description: 'Outchain transaction ID (UUID)',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsUUID()
  @Expose({ name: 'txId' })
  readonly txId: string;

  @ApiProperty({
    description: 'Transaction outputs',
    type: [TransactionOutput],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TransactionOutput)
  @Expose()
  readonly outputs: TransactionOutput[];
}

export class SubmitTransactionDto {
  @ApiProperty({
    description: 'vault id ',
    example: '83a400...',
  })
  @IsString()
  @Expose()
  vaultId: string;

  @ApiProperty({
    description: 'Outchain transaction ID',
    example: '83a400...',
    required: true,
  })
  @IsString()
  @IsNotEmpty()
  @Expose()
  txId: string;

  @ApiProperty({
    description: 'CBOR encoded transaction',
    example: '83a400...',
  })
  @IsString()
  @Expose()
  readonly transaction: string;

  @ApiProperty({
    description: 'Array of CBOR encoded signatures',
    example: ['84a400...'],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Expose()
  readonly signatures?: string[];
}

export class SubmitVaultTxDto extends SubmitTransactionDto {
  @ApiProperty({
    description: 'Vault id',
    example: ['84a400...'],
    required: true,
  })
  @IsNotEmpty()
  @IsString()
  @Expose()
  vaultId: string;
}

export class TransactionBuildResponseDto {
  @ApiProperty({
    description: 'Transaction hash',
    example: '1234abcd...',
  })
  @Expose()
  readonly hash: string;

  @ApiProperty({
    description: 'CBOR encoded complete transaction',
    example: '83a400...',
  })
  @Expose()
  readonly complete: string;

  @ApiProperty({
    description: 'CBOR encoded stripped transaction',
    example: '83a400...',
  })
  @Expose()
  readonly stripped: string;

  @ApiProperty({
    description: 'CBOR encoded witness set',
    example: '83a400...',
  })
  @Expose()
  readonly witnessSet: string;
}

export class TransactionSubmitResponseDto {
  @ApiProperty({
    description: 'Transaction hash',
    example: '1234abcd...',
  })
  @Expose({ name: 'txHash' })
  readonly txHash: string;
}
