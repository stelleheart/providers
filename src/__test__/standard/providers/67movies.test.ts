import { describe, expect, it } from 'vitest';

import { map67MoviesResponse } from '../../../providers/sources/67movies';

describe('map67MoviesResponse()', () => {
  it('maps api qualities into provider streams', () => {
    expect(
      map67MoviesResponse({
        source: {
          url: 'https://cdn.example/1080.mp4',
          qualities: [
            { quality: '1080p', url: 'https://cdn.example/1080.mp4', type: 'mp4' },
            { quality: '480p', url: 'https://cdn.example/480.mp4', type: 'mp4' },
          ],
        },
        subtitles: [],
      }),
    ).toHaveLength(1);
  });
});
