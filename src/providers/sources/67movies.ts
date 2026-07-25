import { flags } from '@/entrypoint/utils/targets';
import { SourcererOutput, makeSourcerer } from '@/providers/base';
import { Stream } from '@/providers/streams';
import { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';

const API_BASE = 'https://ballerinacappuccinalovestungtungtungsahur.com';
const headers = {
  Origin: 'https://player.vidlove.cc',
  Referer: 'https://player.vidlove.cc/',
  Accept: 'application/json',
};

type ApiResponse = {
  source?: {
    url?: string;
    qualities?: { quality?: string; codec?: string; url?: string; type?: string }[];
  };
  subtitles?: { label?: string; display?: string; file?: string; url?: string }[];
};

function parseQuality(value?: string): '360' | '480' | '720' | '1080' | '4k' | 'unknown' {
  const quality = value?.toLowerCase();
  if (quality?.includes('2160') || quality?.includes('4k')) return '4k';
  if (quality?.includes('1080')) return '1080';
  if (quality?.includes('720')) return '720';
  if (quality?.includes('480')) return '480';
  if (quality?.includes('360')) return '360';
  return 'unknown';
}

export function map67MoviesResponse(data: ApiResponse): Stream[] {
  const captions = (data.subtitles ?? [])
    .map((subtitle) => ({
      id: subtitle.file || subtitle.url || '',
      url: subtitle.file || subtitle.url || '',
      language: subtitle.label || subtitle.display || 'unknown',
      type: 'vtt' as const,
      hasCorsRestrictions: false,
    }))
    .filter((caption) => caption.url);
  const qualities = Object.fromEntries(
    (data.source?.qualities ?? [])
      .filter((quality) => quality.url && quality.type === 'mp4')
      .map((quality) => [parseQuality(quality.quality), { type: 'mp4' as const, url: quality.url as string }]),
  );
  if (Object.keys(qualities).length > 0) {
    return [{ id: '67movies-moviebox', type: 'file', qualities, captions, flags: [flags.CORS_ALLOWED] }];
  }
  if (!data.source?.url) return [];
  return [
    {
      id: '67movies-primary',
      type: data.source.url.includes('.m3u8') ? 'hls' : 'file',
      ...(data.source.url.includes('.m3u8')
        ? { playlist: data.source.url }
        : { qualities: { unknown: { type: 'mp4' as const, url: data.source.url } } }),
      captions,
      flags: [flags.CORS_ALLOWED],
    } as Stream,
  ];
}

async function comboScraper(ctx: MovieScrapeContext | ShowScrapeContext): Promise<SourcererOutput> {
  const query: Record<string, string> = {
    id: String(ctx.media.tmdbId),
    mode: 'json',
    sources: 'moviebox',
    hevc: '1',
  };
  if (ctx.media.type === 'show') {
    query.season = String(ctx.media.season.number);
    query.episode = String(ctx.media.episode.number);
  }
  const response = await ctx.proxiedFetcher<ApiResponse | string>(
    `${API_BASE}/${ctx.media.type === 'movie' ? 'movie' : 'tv'}`,
    { headers, query, timeoutMs: 12000 },
  );
  const streams = map67MoviesResponse(typeof response === 'string' ? JSON.parse(response) : response);
  if (streams.length === 0) throw new NotFoundError('No 67movies streams found');
  return { embeds: [], stream: streams };
}

export const sixtySevenMoviesScraper = makeSourcerer({
  id: '67movies',
  name: '67movies',
  rank: 996,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper,
  scrapeShow: comboScraper,
});
