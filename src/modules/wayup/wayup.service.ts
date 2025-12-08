import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import CardanoWasm from '@emurgo/cardano-serialization-lib-nodejs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WayUpService {
  private readonly logger = new Logger(WayUpService.name);
  private readonly blockfrost: BlockFrostAPI;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(private readonly configService: ConfigService) {
    this.blockfrost = new BlockFrostAPI({
      projectId: this.configService.get<string>('BLOCKFROST_TESTNET_API_KEY'),
    });
    this.baseUrl = this.configService.get<string>('ANVIL_API_URL');
    this.apiKey = this.configService.get<string>('ANVIL_API_KEY');
  }

  async sell(policyIds?: { id: string; priceAda: number }[], address?: string) {
    const utxos = await this.blockfrost.addressesUtxosAll(address);

    const filtered = utxos
      .map(u => ({
        ...u,
        amount: u.amount.filter(a => a.unit !== 'lovelace' && policyIds?.some(p => p.id === a.unit.slice(0, 56))),
      }))
      .filter(u => u.amount.length > 0);

    if (filtered.length === 0) {
      throw new Error('No matching assets found');
    }

    const serializedUtxos: string[] = filtered.map(u => {
      const value = CardanoWasm.Value.new(
        CardanoWasm.BigNum.from_str(u.amount.find(a => a.unit === 'lovelace')?.quantity || '0')
      );

      const multiAsset = CardanoWasm.MultiAsset.new();
      u.amount.forEach(a => {
        if (a.unit !== 'lovelace') {
          const policyId = CardanoWasm.ScriptHash.from_bytes(Buffer.from(a.unit.slice(0, 56), 'hex'));
          const assetsMap = CardanoWasm.Assets.new();
          assetsMap.insert(
            CardanoWasm.AssetName.new(Buffer.from(a.unit.slice(56), 'hex')),
            CardanoWasm.BigNum.from_str(a.quantity)
          );
          multiAsset.insert(policyId, assetsMap);
        }
      });
      value.set_multiasset(multiAsset);

      const txOut = CardanoWasm.TransactionOutput.new(CardanoWasm.Address.from_bech32(u.address), value);

      const txUtxo = CardanoWasm.TransactionUnspentOutput.new(
        CardanoWasm.TransactionInput.new(
          CardanoWasm.TransactionHash.from_bytes(Buffer.from(u.tx_hash, 'hex')),
          u.output_index
        ),
        txOut
      );

      return Buffer.from(txUtxo.to_bytes()).toString('hex');
    });

    const create = filtered
      .flatMap(u => u.amount)
      .reduce<{ assets: { policyId: string; assetName: string }; priceAda: number }[]>((acc, a) => {
        const exists = acc.find(
          x => x.assets.policyId === a.unit.slice(0, 56) && x.assets.assetName === a.unit.slice(56)
        );
        if (!exists) {
          const priceObj = policyIds?.find(p => p.id === a.unit.slice(0, 56));
          if (priceObj) {
            acc.push({
              assets: {
                policyId: a.unit.slice(0, 56),
                assetName: a.unit.slice(56),
              },
              priceAda: priceObj.priceAda, // minimum 5 ADA,
            });
          }
        }
        return acc;
      }, []);

    const payload = {
      changeAddress: address,
      utxos: serializedUtxos,
      create,
    };

    console.log(address);
    console.log(serializedUtxos);
    console.log(payload.create);

    try {
      const response = await fetch(`${this.baseUrl}/build-tx`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify(payload),
      });
      return await response.json();
    } catch (e) {
      this.logger.error('Failed to sell NFT', e);
      throw new Error('Failed to sell NFT');
    }
  }
}
