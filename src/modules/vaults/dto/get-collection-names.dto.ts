import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsNumber, IsString, Matches, ValidateNested } from 'class-validator';

export class CollectionItemDto {
  @ApiProperty({
    example: '63efb704b7396890e4d9539d030c0e667739043add65c00f96c586c0',
  })
  @IsString()
  @Matches(/^[0-9a-fA-F]{56}$/, {
    message: 'policyId must be a 56-character hexadecimal string',
  })
  policyId: string;

  @ApiProperty({ example: 'My Policy' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'Asset Name' })
  @IsString()
  assetName: string;

  @ApiProperty({ example: 10 })
  @IsNumber()
  count: number;
}

export class GetCollectionNamesReq {
  @ApiProperty({
    description:
      'Array of collection items used to resolve collection name and verification status (policyId, assetName, name, count)',
    type: [CollectionItemDto],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CollectionItemDto)
  collections: CollectionItemDto[];
}

export class CollectionNameItem {
  @ApiProperty({
    description: 'Policy ID',
    example: '63efb704b7396890e4d9539d030c0e667739043add65c00f96c586c0',
  })
  policyId: string;

  @ApiProperty({
    description: 'Collection name or token ticker (can be null)',
    example: 'Valorum',
    nullable: true,
  })
  collectionName: string | null;

  @ApiProperty({
    description: 'Whether token/collection is verified',
    example: true,
  })
  isVerified: boolean;
}
