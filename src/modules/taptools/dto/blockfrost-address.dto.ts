import { ApiProperty } from '@nestjs/swagger';

export class BlockfrostAssetSumDto {
  @ApiProperty({
    description: 'The unit of the value (Lovelace or concatenation of asset policy_id and hex-encoded asset_name)',
    example: 'lovelace',
  })
  unit: string;

  @ApiProperty({
    description: 'The quantity of the unit',
    example: '42000000',
  })
  quantity: string;
}

export class BlockfrostAddressTotalDto {
  @ApiProperty({
    description: 'Bech32 encoded address',
    example: 'addr1qxqs59lphg8g6qndelq8xwqn60ag3aeyfcp33c2kdp46a09re5df3pzwwmyq946axfcejy5n4x0y99wqpgtp2gd0k09qsgy6pz',
  })
  address: string;

  @ApiProperty({
    description: 'The sum of all received UTXO per asset',
    type: [BlockfrostAssetSumDto],
    example: [
      { unit: 'lovelace', quantity: '42000000' },
      { unit: 'b0d07d45fe9514f80213f4020e5a61241458be626841cde717cb38a76e7574636f696e', quantity: '12' },
    ],
  })
  received_sum: BlockfrostAssetSumDto[];

  @ApiProperty({
    description: 'The sum of all sent UTXO per asset',
    type: [BlockfrostAssetSumDto],
    example: [
      { unit: 'lovelace', quantity: '42000000' },
      { unit: 'b0d07d45fe9514f80213f4020e5a61241458be626841cde717cb38a76e7574636f696e', quantity: '12' },
    ],
  })
  sent_sum: BlockfrostAssetSumDto[];

  @ApiProperty({
    description: 'Count of all transactions on the address',
    example: 12,
  })
  tx_count: number;
}

export class BlockfrostAddressAmountDto {
  @ApiProperty({
    description: 'The unit of the value (Lovelace or concatenation of asset policy_id and hex-encoded asset_name)',
    example: 'lovelace',
  })
  unit: string;

  @ApiProperty({
    description: 'The quantity of the unit',
    example: '42000000',
  })
  quantity: string;
}

export class BlockfrostAddressDto {
  @ApiProperty({
    description: 'Bech32 encoded address',
    example: 'addr1qxqs59lphg8g6qndelq8xwqn60ag3aeyfcp33c2kdp46a09re5df3pzwwmyq946axfcejy5n4x0y99wqpgtp2gd0k09qsgy6pz',
  })
  address: string;

  @ApiProperty({
    description: 'The sum of all the UTXO per asset',
    type: [BlockfrostAddressAmountDto],
    example: [
      { unit: 'lovelace', quantity: '42000000' },
      { unit: 'b0d07d45fe9514f80213f4020e5a61241458be626841cde717cb38a76e7574636f696e', quantity: '12' },
    ],
  })
  amount: BlockfrostAddressAmountDto[];

  @ApiProperty({
    description: 'Stake address that controls the key',
    required: false,
    nullable: true,
    example: 'stake1ux3g2c9dx2nhhehyrezyxpkstartcqmu9hk63qgfkccw5rqttygt7',
  })
  stake_address: string | null;

  @ApiProperty({
    description: 'Address era',
    enum: ['byron', 'shelley'],
    example: 'shelley',
  })
  type: 'byron' | 'shelley';

  @ApiProperty({
    description: 'True if this is a script address',
    example: false,
  })
  script: boolean;
}
