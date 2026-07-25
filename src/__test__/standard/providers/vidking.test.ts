import { describe, expect, it } from 'vitest';

import { decryptVidkingPayload, mapVidkingStreams } from '../../../providers/sources/vidking';

const nativeFeatures = { requires: [], disallowed: [] };
const browserFeatures = { requires: ['cors-allowed' as const], disallowed: [] };
const requiredHeaders = {
  Origin: 'https://vidking.net',
  Referer: 'https://vidking.net',
};

describe('vidking streams', () => {
  it('sets required headers for playlists and segments', () => {
    expect(mapVidkingStreams({ sources: [{ quality: '1080p', url: 'https://cdn.example/video.m3u8' }] }, nativeFeatures)).toEqual([
      expect.objectContaining({
        playlist: 'https://cdn.example/video.m3u8',
        proxyDepth: 2,
        headers: requiredHeaders,
      }),
    ]);
  });

  it('passes required headers to the m3u8 proxy', () => {
    const [stream] = mapVidkingStreams(
      { sources: [{ quality: '1080p', url: 'https://cdn.example/video.m3u8' }] },
      browserFeatures,
    );
    const playlist = new URL(stream.type === 'hls' ? stream.playlist : '');

    expect(playlist.pathname).toBe('/m3u8-proxy');
    expect(JSON.parse(playlist.searchParams.get('headers') || '{}')).toEqual(requiredHeaders);
  });
});

describe('decryptVidkingPayload()', () => {
  it('decrypts encrypted source responses', () => {
    expect(decryptVidkingPayload('VGZV87IKYBFLXpcnvfJi6Wzf', 'fixture-seed', 1078605)).toEqual({ sources: [] });
  });
});
