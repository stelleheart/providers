import { flags } from '@/entrypoint/utils/targets';
import { makeSourcerer } from '@/providers/base';
import type { SourcererOutput } from '@/providers/base';
import type { Qualities } from '@/providers/streams';
import type { StreamFile } from '@/providers/streams';
import type { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';

const API_BASE_URL = 'https://api.1anime.app/anime/animepahe';

type ScrapeCtx = ShowScrapeContext | MovieScrapeContext;

interface SearchItem {
  id: string;
  title: string;
  releaseDate?: number;
  type?: string;
}

interface SearchResponse {
  results?: SearchItem[];
}

interface AnimeEpisode {
  id: string;
  number: number;
}

interface InfoResponse {
  episodes?: AnimeEpisode[];
}

interface SourceItem {
  url: string;
  isM3U8: boolean;
  quality: string;
  isDub: boolean;
}

interface DownloadItem {
  url: string;
  quality: string;
}

interface WatchResponse {
  headers?: {
    Referer?: string;
  };
  sources?: SourceItem[];
  download?: DownloadItem[];
}

type LanguageBucket = 'jpn' | 'eng';

function normalizeTitle(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSearchPath(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('+');
}

function scoreSearchResult(item: SearchItem, title: string, releaseYear: number): number {
  const normalizedNeedle = normalizeTitle(title);
  const normalizedHaystack = normalizeTitle(item.title);

  let score = 0;
  if (normalizedHaystack === normalizedNeedle) score += 100;
  else if (normalizedHaystack.includes(normalizedNeedle) || normalizedNeedle.includes(normalizedHaystack)) score += 50;

  if (typeof item.releaseDate === 'number') {
    const yearDiff = Math.abs(item.releaseDate - releaseYear);
    score += Math.max(0, 10 - yearDiff);
  }

  const itemType = item.type?.toLowerCase() ?? '';
  if (itemType.includes('tv') || itemType.includes('movie')) {
    score += 5;
  }

  return score;
}

function parseQualityLabel(quality: string): Qualities {
  const match = quality.match(/(360|480|720|1080|2160)p/i);
  if (!match) return 'unknown';

  const value = match[1];
  if (value === '2160') return '4k';
  if (value === '360' || value === '480' || value === '720' || value === '1080') return value;
  return 'unknown';
}

function inferLanguage(quality: string, isDub: boolean): LanguageBucket {
  if (isDub) return 'eng';

  const lower = quality.toLowerCase();
  if (lower.includes(' eng') || lower.includes('english') || lower.includes(' dub') || lower.endsWith('eng')) {
    return 'eng';
  }

  return 'jpn';
}

function buildLangStreamId(language: LanguageBucket): string {
  return language === 'eng' ? 'eng-audio' : 'jpn-audio';
}

async function fetchJson<T>(ctx: ScrapeCtx, url: string): Promise<T> {
  console.log(`Fetching URL: ${url}`);
  const response = await ctx.proxiedFetcher<T | string>(url);

  if (typeof response === 'string') {
    const trimmed = response.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed) as T;
      } catch {
        throw new NotFoundError('1Anime Pahe API returned invalid JSON');
      }
    }
    throw new NotFoundError('1Anime Pahe API returned an unexpected response');
  }

  if (!response || typeof response !== 'object') {
    throw new NotFoundError('1Anime Pahe API returned an empty response');
  }

  return response as T;
}

async function findAnimeId(ctx: ScrapeCtx): Promise<string> {
  const queryPath = buildSearchPath(ctx.media.title);
  const response = await fetchJson<SearchResponse>(ctx, `${API_BASE_URL}/${queryPath}`);
  const candidates = response.results ?? [];

  if (!candidates.length) {
    throw new NotFoundError('Anime not found on 1Anime Pahe');
  }

  const best = candidates
    .filter((item) => !!item.id)
    .map((item) => ({ item, score: scoreSearchResult(item, ctx.media.title, ctx.media.releaseYear) }))
    .sort((a, b) => b.score - a.score)[0]?.item;

  if (!best) {
    throw new NotFoundError('No usable anime result on 1Anime Pahe');
  }

  return best.id;
}

async function resolveEpisodeId(ctx: ScrapeCtx, animeId: string): Promise<string> {
  const info = await fetchJson<InfoResponse>(ctx, `${API_BASE_URL}/info/${encodeURIComponent(animeId)}`);
  const episodes = info.episodes ?? [];

  if (!episodes.length) {
    throw new NotFoundError('No episodes found on 1Anime Pahe');
  }

  const targetEpisodeNumber = ctx.media.type === 'movie' ? 1 : ctx.media.episode.number;
  const episode = episodes.find((entry) => entry.number === targetEpisodeNumber) ?? (ctx.media.type === 'movie' ? episodes[0] : null);

  if (!episode?.id) {
    throw new NotFoundError('Episode not found on 1Anime Pahe');
  }

  return episode.id;
}

async function scrapeCombo(ctx: ScrapeCtx): Promise<SourcererOutput> {
  ctx.progress(15);
  const animeId = await findAnimeId(ctx);

  ctx.progress(45);
  const episodeId = await resolveEpisodeId(ctx, animeId);

  ctx.progress(70);
  const watch = await fetchJson<WatchResponse>(ctx, `${API_BASE_URL}/watch?episodeId=${encodeURIComponent(episodeId)}`);

  const hlsReferer = watch.headers?.Referer;
  const sources = watch.sources ?? [];
  const downloads = watch.download ?? [];

  const stream: SourcererOutput['stream'] = [];
  const hlsStreams: NonNullable<SourcererOutput['stream']> = [];
  const fileByLanguage: Record<LanguageBucket, Partial<Record<Qualities, StreamFile>>> = {
    jpn: {},
    eng: {},
  };
  let hlsIndex = 0;

  for (const source of sources) {
    if (!source?.url) continue;

    const quality = parseQualityLabel(source.quality ?? '');
    const language = inferLanguage(source.quality ?? '', source.isDub);

    if (source.isM3U8) {
      if (!hlsReferer) continue;
      hlsStreams.push({
        id: `${buildLangStreamId(language)}-hls-${quality}-${hlsIndex++}`,
        type: 'hls',
        playlist: source.url,
        headers: {
          Referer: hlsReferer,
        },
        captions: [],
        flags: [flags.CORS_ALLOWED],
      });
      continue;
    }

    if (!fileByLanguage[language][quality]) {
      fileByLanguage[language][quality] = { type: 'mp4', url: source.url };
    }
  }

  if (downloads.length) {
    for (const download of downloads) {
      if (!download?.url) continue;
      const quality = parseQualityLabel(download.quality ?? '');
      const language = inferLanguage(download.quality ?? '', false);

      if (!fileByLanguage[language][quality]) {
        fileByLanguage[language][quality] = { type: 'mp4', url: download.url };
      }
    }
  }

  for (const language of ['jpn', 'eng'] as const) {
    if (Object.keys(fileByLanguage[language]).length === 0) continue;

    stream.push({
      id: buildLangStreamId(language),
      type: 'file',
      qualities: fileByLanguage[language],
      captions: [],
      flags: [flags.CORS_ALLOWED],
    });
  }

  // Prefer file streams when available to avoid browser/HLS codec incompatibilities.
  if (stream.length === 0) {
    stream.push(...hlsStreams);
  }

  if (!stream.length) {
    throw new NotFoundError('No valid streams found on 1Anime Pahe');
  }

  ctx.progress(95);
  return {
    embeds: [],
    stream,
  };
}

export const animepaheScraper = makeSourcerer({
  id: 'animepahe',
  name: 'AnimePahe 🔥',
  rank: 201,
  disabled: false,
  flags: [flags.CORS_ALLOWED],
  scrapeShow: scrapeCombo,
  scrapeMovie: scrapeCombo,
});
