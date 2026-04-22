import { Data } from '@lucid-evolution/lucid';

export const StakeDatumSchema = Data.Object({
  owner: Data.Bytes(),
  staked_at: Data.Integer(),
});

export type StakeDatum = Data.Static<typeof StakeDatumSchema>;

/** CBOR hex for inline datum. `Data.to` schema/value generics in plutus are the same parameter; cast is required. */
export function encodeStakeDatum(d: StakeDatum): string {
  return Data.to(d as never, StakeDatumSchema as never) as string;
}

export function tryDecodeStakeDatum(raw: string): StakeDatum | null {
  try {
    return Data.from(raw, StakeDatumSchema as never) as StakeDatum;
  } catch {
    return null;
  }
}
