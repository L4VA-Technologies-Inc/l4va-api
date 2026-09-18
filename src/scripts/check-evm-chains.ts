import { ConfigService } from '@nestjs/config';
import * as dotenv from 'dotenv';

import { loadEvmChains } from '@/modules/evm-chains/evm-chains.config';

dotenv.config();
const chains = loadEvmChains(new ConfigService());
for (const c of chains) {
  console.log(`${c.chainType} chainId=${c.chainId} rpc=${c.rpcUrl}`);
  console.log(`   factory=${c.factoryAddress} deployer=${c.batchDeployerAddress}`);
  console.log(`   admin=${c.adminAddress} minting=${c.mintingSignerAddress} treasury=${c.treasuryAddress}`);
  console.log(
    `   native=${c.nativeCurrency.symbol} maxTxGas=${c.maxTxGas ?? '-'} swap=${c.swap} adminKey=${c.adminPrivateKey ? 'set' : 'MISSING'} mintKey=${c.mintingSignerPrivateKey ? 'set' : 'MISSING'}`
  );
}
