import { describe, expect, it } from 'vitest';

import { decryptVidkingPayload, mapVidkingStreams } from '../../../providers/sources/vidking';

const features = { requires: [], disallowed: [] };

describe('vidking streams', () => {
  it('sets required headers for playlists and segments', () => {
    expect(
      mapVidkingStreams({ sources: [{ quality: '1080p', url: 'https://cdn.example/video.m3u8' }] }, features),
    ).toEqual([
      expect.objectContaining({
        playlist: 'https://cdn.example/video.m3u8',
        proxyDepth: 2,
        headers: {
          Origin: 'https://vidking.net',
          Referer: 'https://vidking.net',
        },
      }),
    ]);
  });
});

describe('decryptVidkingPayload()', () => {
  it('decrypts encrypted source responses', () => {
    expect(decryptVidkingPayload('VGZV87IKYBFLXpcnvfJi6Wzf', 'fixture-seed', 1078605)).toEqual({ sources: [] });
  });
});
