import { ConfigService } from '@nestjs/config';

import { TokenType } from '@/database/tokenStakingPosition.entity';

export type TokenMeta = { decimals: number; type: TokenType | null };

function getValidatedDecimals(configService: ConfigService, key: string, defaultValue: number): number {
  const parsed = parseInt(configService.get<string>(key) ?? String(defaultValue), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : defaultValue;
}

export function buildStakeTokenRegistry(configService: ConfigService): Map<string, TokenMeta> {
  const map = new Map<string, TokenMeta>();

  const vlrmPolicy = configService.get<string>('VLRM_POLICY_ID')?.toLowerCase();
  const vlrmName = configService.get<string>('VLRM_HEX_ASSET_NAME')?.toLowerCase() ?? '';
  const vlrmDecimals = getValidatedDecimals(configService, 'VLRM_DECIMALS', 4);
  if (vlrmPolicy) {
    map.set(`${vlrmPolicy}${vlrmName}`, {
      decimals: vlrmDecimals,
      type: TokenType.VLRM,
    });
  }

  const l4vaPolicy = configService.get<string>('L4VA_POLICY_ID')?.toLowerCase();
  const l4vaName = configService.get<string>('L4VA_ASSET_NAME')?.toLowerCase() ?? '';
  const l4vaDecimals = getValidatedDecimals(configService, 'L4VA_DECIMALS', 3);
  if (l4vaPolicy) {
    map.set(`${l4vaPolicy}${l4vaName}`, {
      decimals: l4vaDecimals,
      type: TokenType.L4VA,
    });
  }

  return map;
}
