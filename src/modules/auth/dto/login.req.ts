import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsObject, ValidateNested } from 'class-validator';
import { Expose, Type } from 'class-transformer';

export class SignatureData {
  @Expose()
  @IsNotEmpty()
  @IsString()
  @ApiProperty({
    description: 'Public key for signature verification',
    example: 'a4010103272006215820b1a4728380a82aa00b642a481a8b4bbe972758252e95c49c77b4244a50af8883'
  })
  key: string;

  @Expose()
  @IsNotEmpty()
  @IsString()
  @ApiProperty({
    description: 'Signature data',
    example: '84582aa201276761646472657373581de106605a47f78e1d609e4e481f5972858dc6281bda52095ca8803cecbca166686173686564f458446163636f756e743a207374616b653175797278716b6a38373738703663793766657970376b746a736b78757632716d6d6666716a683967737137776530713677617576345840db43ea4a559292bcd731c8db7dce1eb825dc3633e873ca3fd8786a6e105b14e07c7ed281291a076de39ab583d9f112ea581ffd2c3f24318d6127196576ae340e'
  })
  signature: string;
}

export class LoginReq {
  @Expose()
  @IsNotEmpty()
  @IsObject()
  @ValidateNested()
  @Type(() => SignatureData)
  @ApiProperty({
    description: 'Signature data for authentication',
    type: SignatureData
  })
  signature: SignatureData;

  @Expose()
  @IsNotEmpty()
  @IsString()
  @ApiProperty({
    description: 'Stake address for the wallet',
    example: 'stake1uyrxqkj8778p6cy7feyp7ktjskxuv2qmmffqjh9gsq7we0q6wauv4'
  })
  stakeAddress: string;


  @Expose()
  @IsNotEmpty()
  @IsString()
  @ApiProperty({
    description: 'Wallet address for the wallet',
    example: 'addr1q934ccfkwy292....'
  })
  walletAddress: string;
}
