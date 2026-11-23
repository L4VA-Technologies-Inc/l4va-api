import { describe, expect, it } from '@jest/globals';

import { countSnapshotRecipients, snapshotRecipients } from './snapshot-recipients.util';

const A = '0x98D2d01a47f18131E873dA110fBB8bf60C844c73';
const B = '0x3A27AE23D578Ee0C540c3cd717e947211219d5D5';
const LP = '0x7b309AC52b187E952a9d92d947B8b606347A510F';

describe('snapshotRecipients', () => {
  it('counts VT holders plus LP providers (the 0x67b9… vault case: 2 + 1 = 3)', () => {
    expect(
      countSnapshotRecipients({
        addressBalances: { [A]: '520967000000000000000000', [B]: '419870000000000000000000' },
        lpBalances: { [LP.toLowerCase()]: '9000000000000000000000' },
      })
    ).toBe(3);
  });

  it('counts an address in both maps once, whatever its case', () => {
    expect(countSnapshotRecipients({ addressBalances: { [A]: '1' }, lpBalances: { [A.toLowerCase()]: '5' } })).toBe(1);
  });

  it('drops zero balances and empty addresses; handles missing maps', () => {
    expect(countSnapshotRecipients({ addressBalances: { [A]: '0', '': '7', [B]: '2' }, lpBalances: null })).toBe(1);
    expect(countSnapshotRecipients(null)).toBe(0);
    expect(countSnapshotRecipients({ addressBalances: {}, lpBalances: { [LP]: '0' } })).toBe(0);
  });

  it('returns lowercased addresses', () => {
    expect([...snapshotRecipients({ addressBalances: { [A]: '1' }, lpBalances: null })]).toEqual([A.toLowerCase()]);
  });
});
