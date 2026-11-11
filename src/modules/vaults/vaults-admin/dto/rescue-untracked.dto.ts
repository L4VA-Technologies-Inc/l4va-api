import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumberString, IsOptional, Matches, Min } from 'class-validator';

export class RescueUntrackedDto {
  @ApiProperty({ description: 'Hash of the transaction that sent the asset straight to the vault' })
  @Matches(/^0x[0-9a-fA-F]{64}$/)
  txHash: string;

  @ApiProperty({ description: 'Log index of the transfer inside that transaction (from the preview)' })
  @IsInt()
  @Min(0)
  logIndex: number;

  @ApiPropertyOptional({ description: 'Token id; needed only for an ERC-1155 batch transfer' })
  @IsOptional()
  @IsNumberString()
  tokenId?: string;
}
