import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsArray, IsString, IsOptional, Min } from 'class-validator';

export class CreateListingDto {
  @ApiProperty({ description: 'Price for the asset in ADA (minimum 5 ADA)' })
  @IsNumber()
  @Min(5, { message: 'Minimum listing price is 5 ADA' })
  price: number;

  @ApiProperty({
    description: 'UTXOs from vault containing the NFT to list',
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  utxos: string[];

  @ApiProperty({ description: 'Additional metadata', required: false })
  @IsOptional()
  metadata?: Record<string, any>;
}

export class UpdateListingDto {
  @ApiProperty({ description: 'New price for the asset in ADA (minimum 5 ADA)' })
  @IsNumber()
  @Min(5, { message: 'Minimum listing price is 5 ADA' })
  newPrice: number;

  @ApiProperty({
    description: 'UTXOs to fund the transaction',
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  utxos: string[];

  @ApiProperty({
    description: 'Transaction hash and output index in format txHash#outputIndex',
  })
  @IsString()
  txHashIndex: string;
}
