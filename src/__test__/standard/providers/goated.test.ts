import { describe, expect, it } from 'vitest';

import { decryptGoatedPayload, deriveGoatedKey, encryptGoatedPayload } from '../../../providers/sources/goated';

describe('goated payload crypto', () => {
  it('round-trips encrypted api data', async () => {
    const key = await deriveGoatedKey('fixture-token');
    const encrypted = await encryptGoatedPayload({ type: 'movie', id: '1078605' }, key);

    expect(JSON.parse(await decryptGoatedPayload(encrypted, key))).toEqual({ type: 'movie', id: '1078605' });
  });
});
