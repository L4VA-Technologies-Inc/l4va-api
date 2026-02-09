import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsString, Matches } from 'class-validator';

export class GetCollectionNamesReq {
  @ApiProperty({
    description: 'Array of policy IDs to look up collection names for',
    example: ['63efb704b7396890e4d9539d030c0e667739043add65c00f96c586c0'],
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Matches(/^[0-9a-fA-F]{56}$/, {
    each: true,
    message: 'Each policy ID must be a 56-character hexadecimal string',
  })
  policyIds: string[];
}

export class CollectionNameItem {
  @ApiProperty({
    description: 'Policy ID',
    example: '63efb704b7396890e4d9539d030c0e667739043add65c00f96c586c0',
  })
  policyId: string;

  @ApiProperty({
    description: 'Collection name or token ticker',
    example: 'Valorum',
    nullable: true,
  })
  collectionName: string | null;
}
