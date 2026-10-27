import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsArray, IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

import { VoteType } from '@/types/vote.types';

export class VoteReq {
  @ApiProperty({
    description: 'Selected voting option',
    example: 'yes',
    enum: VoteType,
  })
  @IsNotEmpty()
  @IsEnum(VoteType)
  @Expose()
  vote: VoteType;

  @ApiProperty({
    description: "The voter's Cardano address",
    example: 'addr_test1qpjavyk....nw8s46zete',
  })
  @IsNotEmpty()
  @IsString()
  @Expose()
  voterAddress: string;

  // --- Voting fee proof -----------------------------------------------------
  // Required only when the chain's voting fee is above zero. Cardano supplies
  // the signed transaction for the API to submit; EVM supplies the hash of a
  // transfer the wallet already broadcast.

  @ApiProperty({
    description: 'CBOR encoded voting fee transaction (Cardano vaults, when a voting fee applies)',
    example: '84a400...',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Expose()
  feeTransaction?: string;

  @ApiProperty({
    description: 'CBOR encoded signatures for the voting fee transaction (Cardano vaults)',
    example: ['84a400...'],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Expose()
  feeSignatures?: string[];

  @ApiProperty({
    description: 'Hash of the native fee transfer already broadcast by the wallet (EVM vaults)',
    example: '0xabc123...',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Expose()
  feeTxHash?: string;
}
