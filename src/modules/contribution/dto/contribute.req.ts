import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, ValidateNested, IsString, IsNumber, IsObject } from 'class-validator';
import { Expose, Type, Transform } from 'class-transformer';

class MetadataFile {
  @ApiProperty()
  @IsString()
  src: string;

  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  mediaType: string;
}

class OnchainMetadata {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty({ type: [MetadataFile] })
  @Type(() => MetadataFile)
  files: MetadataFile[];

  @ApiProperty()
  @IsString()
  image: string;

  @ApiProperty()
  @IsString()
  owner: string;

  @ApiProperty()
  @IsString()
  mediaType: string;

  @ApiProperty()
  @IsString()
  description: string;
}

class ContributionAsset {
  @ApiProperty({
    description: 'Policy ID of the asset (56-character hex string)',
    example: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd',
  })
  @IsNotEmpty()
  @Expose()
  policyId: string;

  @ApiProperty({
    description: 'Asset name within the policy',
    example: 'l4vaaudiEngine',
  })
  @IsNotEmpty()
  @Expose()
  assetName: string;

  @ApiProperty({
    description: 'Quantity of assets to contribute',
    example: 1,
  })
  @IsNotEmpty()
  @Expose()
  quantity: number;

  @ApiPropertyOptional({
    description: 'Asset metadata including on-chain details',
    type: 'object',
    additionalProperties: true,
    example: {
      policyId: 'c365b10e9d9400767d234315841c6dd750a1b681d2ae069d4191ed6e',
      fingerprint: 'asset1tt9r6rl0dnft95w6smsaacg86sylf47hxkaz40',
      decimals: 0,
      description: '',
      image: 'ipfs://QmcqzB25HmkAnEnZs8ZQAsL6J6Jrsh4grN6HZPd5UasaRw',
      mediaType: 'image/png',
      files: [{
        src: 'ipfs://QmcqzB25HmkAnEnZs8ZQAsL6J6Jrsh4grN6HZPd5UasaRw',
        name: 'Igor 3',
        mediaType: 'image/png'
      }],
      attributes: {},
      assetName: '4c34766149676f722033',
      mintTx: '98ec166ee46a4e56d9cadf28848a99e28ea4703f478c6c3aef4bd1553866667c',
      mintQuantity: '1',
      onchainMetadata: {
        name: 'Igor 3',
        files: [{
          src: 'ipfs://QmcqzB25HmkAnEnZs8ZQAsL6J6Jrsh4grN6HZPd5UasaRw',
          name: 'Igor 3',
          mediaType: 'image/png'
        }],
        image: 'ipfs://QmcqzB25HmkAnEnZs8ZQAsL6J6Jrsh4grN6HZPd5UasaRw',
        owner: 'L4va',
        mediaType: 'image/png',
        description: ''
      }
    }
  })
  @Expose()
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch (e) {
        return {};
      }
    }
    return value || {};
  })
  metadata?: Record<string, any>;
}

export class ContributeReq {

  @ApiProperty({
    type: [ContributionAsset],
    description: 'List of assets to contribute',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ContributionAsset)
  @Expose()
  assets: ContributionAsset[];
}
