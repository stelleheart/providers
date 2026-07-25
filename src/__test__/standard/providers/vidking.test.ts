import { describe, expect, it } from 'vitest';

import { decryptVidkingPayload } from '../../../providers/sources/vidking';

describe('decryptVidkingPayload()', () => {
  it('decrypts encrypted source responses', () => {
    expect(decryptVidkingPayload('VGZV87IKYBFLXpcnvfJi6Wzf', 'fixture-seed', 1078605)).toEqual({ sources: [] });
  });
});
