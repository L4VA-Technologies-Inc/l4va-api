import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { CreatePoolDto } from './dto/create-pool.dto';
import { Address, FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { ConfigService } from '@nestjs/config';
import { Buffer } from 'buffer';

const poolOwner = {
  'skey': 'ed25519e_sk1eqleq0gr7awjymmkcehm4pza8ffq385fyxkntqe74u384fgfs4w7vncmhdlc2u2l78g4r82ctfw6s36dnuguadxh3lggluy9pwansegfprll7',
  'skey_hex': 'c83f903d03f75d226f76c66fba845d3a52089e8921ad35833eaf227aa509855de64f1bbb7f85715ff1d1519d585a5da8474d9f11ceb4d78fd08ff0850bbb3865',
  'pkey': 'ed25519_pk1d70wgjreu5aw3guw8wfvv4etv689t096mcs34gzfl7x297ycrxmqv8dpyd',
  'pkey_hex': '6f9ee44879e53ae8a38e3b92c6572b668e55bcbade211aa049ff8ca2f89819b6',
  'key_hash': '255eb2c9db29a0660197bbd0dc0b8a62c6a6f926816a7f3a87882dc8',
  'base_address_mainnet': 'addr1qyj4avkfmv56qespj7aaphqt3f3vdfhey6qk5le6s7yzmjp9t6evnkef5pnqr9am6rwqhznzc6n0jf5pdfln4pug9hyqqjywf2',
  'base_address_preprod': 'addr_test1qqj4avkfmv56qespj7aaphqt3f3vdfhey6qk5le6s7yzmjp9t6evnkef5pnqr9am6rwqhznzc6n0jf5pdfln4pug9hyqryew94',
  'base_address_preview': 'addr_test1qqj4avkfmv56qespj7aaphqt3f3vdfhey6qk5le6s7yzmjp9t6evnkef5pnqr9am6rwqhznzc6n0jf5pdfln4pug9hyqryew94',
  'enterprise_address_mainnet': 'addr1vyj4avkfmv56qespj7aaphqt3f3vdfhey6qk5le6s7yzmjqq4wdt7',
  'enterprise_address_preprod': 'addr_test1vqj4avkfmv56qespj7aaphqt3f3vdfhey6qk5le6s7yzmjqma63ym',
  'enterprise_address_preview': 'addr_test1vqj4avkfmv56qespj7aaphqt3f3vdfhey6qk5le6s7yzmjqma63ym',
  'reward_address_mainnet': 'stake1uyj4avkfmv56qespj7aaphqt3f3vdfhey6qk5le6s7yzmjqulwthv',
  'reward_address_preprod': 'stake_test1uqj4avkfmv56qespj7aaphqt3f3vdfhey6qk5le6s7yzmjqm4yfn3',
  'reward_address_preview': 'stake_test1uqj4avkfmv56qespj7aaphqt3f3vdfhey6qk5le6s7yzmjqm4yfn3',
  'mnemonic': 'honey please six minute arena renew switch wave witness evolve salon power case hair chaos piano cart claim spin voyage fantasy wife offer boy'
};

// Constants for VyFi pool creation
const VYFI_CONSTANTS = {
  PROCESSING_FEE: 1900000, // 1.9 ADA in lovelace
  MIN_POOL_ADA: 2000000, // 2 ADA in lovelace
  MIN_RETURN_ADA: 2000000, // 2 ADA in lovelace
  TOTAL_REQUIRED_ADA: 5900000, // 5.9 ADA in lovelace
  POOL_ADDRESS: 'addr1qy5dasujdtm4hzrtamca9sjetu78hgqt8rkqs9tu69n0vq47wr70fcgkj4fe9tyr6z2jz8qvwvrc2gq04ltky960fw0smcuf0t',
  METADATA_LABEL: '53554741',
};

@Injectable()
export class VyfiService {
  private readonly vyfiApiUrl = 'https://api.vyfi.io';
  private readonly adaAnvilApiUrl = 'https://preprod.api.ada-anvil.app/v2/services/transactions';
  private readonly poolOwner: any;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.poolOwner = poolOwner;
  }

  async checkPool(params: {
    networkId: number;
    tokenAUnit: string;
    tokenBUnit: string;
  }) {
    const { networkId, tokenAUnit, tokenBUnit } = params;
    const url = `${this.vyfiApiUrl}/lp`;
    const queryParams = new URLSearchParams({
      networkId: networkId.toString(),
      tokenAUnit,
      tokenBUnit,
      v2: 'true',
    });

    try {
      const response = await firstValueFrom(
        this.httpService.get(`${url}?${queryParams.toString()}`)
      );
      return {
        exists: true,
        data: response.data,
      };
    } catch (error) {
      if (error.response?.status === 500) {
        return {
          exists: false,
          error: 'Pool does not exist',
        };
      }
      throw new Error(`Failed to check VyFi pool: ${error.message}`);
    }
  }

  private formatMetadataText(tokenA: { policyId?: string; assetName: string }, tokenB: { policyId?: string; assetName: string }): string {
    const shortA = tokenA.policyId ? tokenA.policyId.substring(0, 8) : 'lovelace';
    const shortB = tokenB.policyId ? tokenB.policyId.substring(0, 8) : 'lovelace';
    return `VyFi: LP Factory Create Pool Order Request -- /${VYFI_CONSTANTS.METADATA_LABEL} ${shortA}/${shortB}`;
  }

  async createLiquidityPool(createPoolDto: CreatePoolDto) {
    const {
      networkId,
      tokenA,
      tokenB,
    } = createPoolDto;

    // First check if pool exists
    const poolCheck = await this.checkPool({
      networkId,
      tokenAUnit: tokenA.policyId ? `${tokenA.policyId}${tokenA.assetName}` : 'lovelace',
      tokenBUnit: tokenB.policyId ? `${tokenB.policyId}${tokenB.assetName}` : 'lovelace',
    });

    if (poolCheck.exists) {
      throw new Error('Pool already exists');
    }

    const CUSTOMER_ADDRESS = this.poolOwner.base_address_preprod;

    // Generate metadata
    const metadataText = this.formatMetadataText(tokenA, tokenB);

    // Get UTxOs
    const utxos = await this.getUtxos(Address.from_bech32(CUSTOMER_ADDRESS));
    if (utxos.len() === 0) {
      throw new Error('No UTXOs found');
    }

    const selectedUtxo = utxos.get(0);
    const REQUIRED_INPUTS = [selectedUtxo.to_hex()];

    // Construct transaction input with proper ADA amounts
    const input = {
      changeAddress: CUSTOMER_ADDRESS,
      message: 'Create Liquidity Pool',
      outputs: [
        {
          address: VYFI_CONSTANTS.POOL_ADDRESS,
          assets: [
            {
              assetName: { name: tokenA.assetName, format: 'hex' },
              policyId: tokenA.policyId,
              quantity: tokenA.amount,
            },
            {
              assetName: { name: tokenB.assetName, format: 'hex' },
              policyId: tokenB.policyId,
              quantity: tokenB.amount,
            },
          ],
          lovelace: VYFI_CONSTANTS.TOTAL_REQUIRED_ADA,
        },
      ],
      metadata: {
        [VYFI_CONSTANTS.METADATA_LABEL]: metadataText,
      },
      requiredInputs: REQUIRED_INPUTS,
    };

    // Get API key from config
    const apiKey = this.configService.get<string>('VYFI_API_KEY');
    if (!apiKey) {
      throw new Error('VYFI_API_KEY not configured');
    }

    // Build the transaction
    const buildResponse = await firstValueFrom(
      this.httpService.post(
        `${this.adaAnvilApiUrl}/build`,
        input,
        {
          headers: {
            'x-api-key': apiKey,
            'Content-Type': 'application/json',
          },
        }
      )
    );

    const transaction = buildResponse.data;

    // Sign the transaction
    const txToSubmitOnChain = FixedTransaction.from_bytes(
      Buffer.from(transaction.complete, 'hex')
    );

    txToSubmitOnChain.sign_and_add_vkey_signature(
      PrivateKey.from_bech32(this.poolOwner.skey)
    );

    // Submit the transaction
    const submitResponse = await firstValueFrom(
      this.httpService.post(
        `${this.adaAnvilApiUrl}/submit`,
        {
          signatures: [],
          transaction: txToSubmitOnChain.to_hex(),
        },
        {
          headers: {
            'x-api-key': apiKey,
            'Content-Type': 'application/json',
          },
        }
      )
    );

    return {
      ...submitResponse.data,
      poolAddress: VYFI_CONSTANTS.POOL_ADDRESS,
      fees: {
        processingFee: VYFI_CONSTANTS.PROCESSING_FEE,
        minPoolAda: VYFI_CONSTANTS.MIN_POOL_ADA,
        minReturnAda: VYFI_CONSTANTS.MIN_RETURN_ADA,
        totalRequiredAda: VYFI_CONSTANTS.TOTAL_REQUIRED_ADA,
      },
    };
  }

  private async getUtxos(address: Address) {
    const apiKey = this.configService.get<string>('BLOCKFROST_API_KEY');
    if (!apiKey) {
      throw new Error('BLOCKFROST_API_KEY not configured');
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `https://cardano-preprod.blockfrost.io/api/v0/addresses/${address.to_bech32()}/utxos`,
          {
            headers: {
              'project_id': apiKey,
            },
          }
        )
      );
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get UTXOs: ${error.message}`);
    }
  }

  async getPoolInfo(poolId: string) {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.vyfiApiUrl}/pool/${poolId}`)
      );
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get VyFi pool info: ${error.message}`);
    }
  }
} 