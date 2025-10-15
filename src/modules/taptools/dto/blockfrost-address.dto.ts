import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class BlockfrostAssetSumDto {
  @ApiProperty({
    description: 'The unit of the value (Lovelace or concatenation of asset policy_id and hex-encoded asset_name)',
    example: 'lovelace',
  })
  @Expose()
  unit: string;

  @ApiProperty({
    description: 'The quantity of the unit',
    example: '42000000',
  })
  @Expose()
  quantity: string;
}

export class BlockfrostAddressTotalDto {
  @ApiProperty({
    description: 'Bech32 encoded address',
    example: 'addr1qxqs59lphg8g6qndelq8xwqn60ag3aeyfcp33c2kdp46a09re5df3pzwwmyq946axfcejy5n4x0y99wqpgtp2gd0k09qsgy6pz',
  })
  @Expose()
  address: string;

  @ApiProperty({
    description: 'The sum of all received UTXO per asset',
    type: [BlockfrostAssetSumDto],
    example: [
      { unit: 'lovelace', quantity: '42000000' },
      { unit: 'b0d07d45fe9514f80213f4020e5a61241458be626841cde717cb38a76e7574636f696e', quantity: '12' },
    ],
  })
  @Expose()
  received_sum: BlockfrostAssetSumDto[];

  @ApiProperty({
    description: 'The sum of all sent UTXO per asset',
    type: [BlockfrostAssetSumDto],
    example: [
      { unit: 'lovelace', quantity: '42000000' },
      { unit: 'b0d07d45fe9514f80213f4020e5a61241458be626841cde717cb38a76e7574636f696e', quantity: '12' },
    ],
  })
  @Expose()
  sent_sum: BlockfrostAssetSumDto[];

  @ApiProperty({
    description: 'Count of all transactions on the address',
    example: 12,
  })
  @Expose()
  tx_count: number;
}

export class BlockfrostAddressAmountDto {
  @ApiProperty({
    description: 'The unit of the value (Lovelace or concatenation of asset policy_id and hex-encoded asset_name)',
    example: 'lovelace',
  })
  @Expose()
  unit: string;

  @ApiProperty({
    description: 'The quantity of the unit',
    example: '42000000',
  })
  @Expose()
  quantity: string;
}

export class BlockfrostAddressDto {
  @ApiProperty({
    description: 'Bech32 encoded address',
    example: 'addr1qxqs59lphg8g6qndelq8xwqn60ag3aeyfcp33c2kdp46a09re5df3pzwwmyq946axfcejy5n4x0y99wqpgtp2gd0k09qsgy6pz',
  })
  @Expose()
  address: string;

  @ApiProperty({
    description: 'The sum of all the UTXO per asset',
    type: [BlockfrostAddressAmountDto],
    example: [
      { unit: 'lovelace', quantity: '42000000' },
      { unit: 'b0d07d45fe9514f80213f4020e5a61241458be626841cde717cb38a76e7574636f696e', quantity: '12' },
    ],
  })
  @Expose()
  amount: BlockfrostAddressAmountDto[];

  @ApiProperty({
    description: 'Stake address that controls the key',
    required: false,
    nullable: true,
    example: 'stake1ux3g2c9dx2nhhehyrezyxpkstartcqmu9hk63qgfkccw5rqttygt7',
  })
  @Expose()
  stake_address: string | null;

  @ApiProperty({
    description: 'Address era',
    enum: ['byron', 'shelley'],
    example: 'shelley',
  })
  @Expose()
  type: 'byron' | 'shelley';

  @ApiProperty({
    description: 'True if this is a script address',
    example: false,
  })
  @Expose()
  script: boolean;
}

export class BlockfrostUtxoAmountDto {
  @ApiProperty({
    description: 'The unit of the value (Lovelace or concatenation of asset policy_id and hex-encoded asset_name)',
    example: 'lovelace',
  })
  @Expose()
  unit: string;

  @ApiProperty({
    description: 'The quantity of the unit',
    example: '42000000',
  })
  @Expose()
  quantity: string;
}

export class BlockfrostUtxoDto {
  @ApiProperty({
    description: 'Bech32 encoded addresses - useful when querying by payment_cred',
    example: 'addr1qxqs59lphg8g6qndelq8xwqn60ag3aeyfcp33c2kdp46a09re5df3pzwwmyq946axfcejy5n4x0y99wqpgtp2gd0k09qsgy6pz',
  })
  @Expose()
  address: string;

  @ApiProperty({
    description: 'Transaction hash of the UTXO',
    example: '39a7a284c2a0948189dc45dec670211cd4d72f7b66c5726c08d9b3df11e44d58',
  })
  @Expose()
  tx_hash: string;

  @ApiProperty({
    description: 'UTXO index in the transaction (deprecated)',
    deprecated: true,
    example: 0,
  })
  @Expose()
  tx_index: number;

  @ApiProperty({
    description: 'UTXO index in the transaction',
    example: 0,
  })
  @Expose()
  output_index: number;

  @ApiProperty({
    description: 'The sum of all the UTXO per asset',
    type: [BlockfrostUtxoAmountDto],
    example: [
      { unit: 'lovelace', quantity: '42000000' },
      { unit: 'b0d07d45fe9514f80213f4020e5a61241458be626841cde717cb38a76e7574636f696e', quantity: '12' },
    ],
  })
  @Expose()
  amount: BlockfrostUtxoAmountDto[];

  @ApiProperty({
    description: 'Block hash of the UTXO',
    example: '7eb8e27d18686c7db9a18f8bbcfe34e3fed6e047afaa2d969904d15e934847e6',
  })
  @Expose()
  block: string;

  @ApiProperty({
    description: 'The hash of the transaction output datum',
    required: false,
    nullable: true,
    example: '9e478573ab81ea7a8e31891ce0648b81229f408d596a3483e6f4f9b92d3cf710',
  })
  @Expose()
  data_hash: string | null;

  @ApiProperty({
    description: 'CBOR encoded inline datum',
    required: false,
    nullable: true,
    example: '19a6aa',
  })
  @Expose()
  inline_datum: string | null;

  @ApiProperty({
    description: 'The hash of the reference script of the output',
    required: false,
    nullable: true,
    example: '13a3efd825703a352a8f71f4e2758d08c28c564e8dfcce9f77776ad1',
  })
  @Expose()
  reference_script_hash: string | null;
}
