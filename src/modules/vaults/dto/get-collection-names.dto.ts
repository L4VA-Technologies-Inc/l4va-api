import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

export class GetCollectionNamesReq {
  @ApiProperty({
    description: 'Array of policy IDs to look up collection names for',
    example: ['63efb704b7396890e4d9539d030c0e667739043add65c00f96c586c0'],
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
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
