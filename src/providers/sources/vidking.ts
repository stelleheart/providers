import { FeatureMap, flags } from '@/entrypoint/utils/targets';
import { SourcererOutput, makeSourcerer } from '@/providers/base';
import { Stream } from '@/providers/streams';
import { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';
import { createM3U8ProxyUrl } from '@/utils/proxy';

const API_BASE = 'https://api.speedracelight.com';
const DB_BASE = 'https://db.speedracelight.com/3';
const headers = {
  Origin: 'https://www.vidking.net',
  Referer: 'https://www.vidking.net/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
};
const streamHeaders = {
  Origin: 'https://vidking.net',
  Referer: 'https://vidking.net',
};
const MIX_CONSTANT = 2654435769;
const HASH_CONSTANTS = [
  1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401,
  607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580,
];
const INITIAL_HASH = [1732584193, 4023233417, 2562383102, 271733878];

type VidkingData = {
  sources?: { quality?: string; url?: string }[];
  subtitles?: { lang?: string; language?: string; url?: string }[];
};

type CipherState = { table: number[]; accumulator: number };

function mix(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 2246822507) >>> 0;
  mixed ^= mixed >>> 13;
  mixed = Math.imul(mixed, 3266489909) >>> 0;
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

function rotateLeft(value: number, shift: number): number {
  const amount = shift & 31;
  return amount === 0 ? value >>> 0 : ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

function seedHash(seed: string): number {
  let value = INITIAL_HASH[0] >>> 0;
  for (let index = 0; index < seed.length; index += 1) {
    value = rotateLeft((value ^ Math.imul(seed.charCodeAt(index), HASH_CONSTANTS[index & 15])) >>> 0, 5);
  }
  return mix(value);
}

function fnvHash(seed: string): number {
  let value = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    value = Math.imul(value ^ seed.charCodeAt(index), 16777619) >>> 0;
  }
  return mix(value);
}

function makeCipherState(seed: string, mediaId: number): CipherState {
  if (((seed.length * (seed.length + 1)) & 1) === 1) {
    const table = Array.from({ length: 256 }, (_, index) => index);
    let cursor = 0;
    for (let index = 0; index < table.length; index += 1) {
      cursor = (cursor + table[index] + seed.charCodeAt(index % seed.length)) & 255;
      [table[index], table[cursor]] = [table[cursor], table[index]];
    }
    return { table, accumulator: seedHash(seed) };
  }

  const table = new Array<number>(61);
  let value = mix(fnvHash(seed) ^ mix((mediaId >>> 0) ^ MIX_CONSTANT));
  for (let index = 0; index < 8; index += 1) {
    if (((index * (index + 1)) & 1) === 0) {
      const cursor = value % 61;
      value = rotateLeft((value + MIX_CONSTANT) >>> 0, 7 + (index & 7));
      table[cursor] = (value ^ mix(value)) >>> 0;
      value = mix((value + cursor) >>> 0);
    } else table[index] = HASH_CONSTANTS[index & 15];
  }
  return { table, accumulator: mix(value ^ 2779096485) };
}

function nextCipherWord(state: CipherState, index: number): number {
  const cursor = state.accumulator % 61;
  const presentMask = -(cursor in state.table);
  const tableValue = state.table[cursor] >>> 0;
  const counter = Math.imul(MIX_CONSTANT, index + 1) >>> 0;
  const choice =
    ((state.accumulator ^ (tableValue ^ counter)) | (state.accumulator & (tableValue ^ counter) & presentMask)) >>> 0;
  const word =
    rotateLeft((choice + state.accumulator) >>> 0, cursor & 31) ^
    rotateLeft(state.accumulator, Math.imul(cursor, 7) & 31);
  state.accumulator = mix((word + MIX_CONSTANT) >>> 0);
  state.table[cursor] = state.accumulator;
  return state.accumulator;
}

export function decryptVidkingPayload(payload: string, seed: string, mediaId: number): VidkingData {
  const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  const state = makeCipherState(seed, mediaId);
  for (let index = 0, block = 0; index < bytes.length; block += 1) {
    const word = nextCipherWord(state, block);
    for (let offset = 0; offset < 4 && index < bytes.length; offset += 1, index += 1) {
      bytes[index] ^= (word >>> (offset * 8)) & 255;
    }
  }
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== 'mvm1') throw new NotFoundError('Invalid Vidking payload');
  return JSON.parse(new TextDecoder().decode(bytes.subarray(4)));
}

export function mapVidkingStreams(data: VidkingData, features: FeatureMap): Stream[] {
  const captions = (data.subtitles ?? [])
    .filter((subtitle) => subtitle.url)
    .map((subtitle) => ({
      id: subtitle.url as string,
      url: subtitle.url as string,
      language: subtitle.language || subtitle.lang || 'unknown',
      type: 'vtt' as const,
      hasCorsRestrictions: false,
    }));
  return (data.sources ?? [])
    .filter((source) => source.url?.includes('.m3u8'))
    .map((source, index) => ({
      id: `vidking-${source.quality || index}`,
      type: 'hls',
      playlist: createM3U8ProxyUrl(source.url as string, features, streamHeaders),
      headers: streamHeaders,
      proxyDepth: 2,
      flags: [flags.CORS_ALLOWED],
      captions,
    }));
}

async function comboScraper(ctx: ShowScrapeContext | MovieScrapeContext): Promise<SourcererOutput> {
  const mediaId = Number(ctx.media.tmdbId);
  const mediaType = ctx.media.type === 'movie' ? 'movie' : 'tv';
  const metadataResponse = await ctx.proxiedFetcher<any>(`${DB_BASE}/${mediaType}/${mediaId}`, {
    headers,
    query: { append_to_response: 'external_ids' },
  });
  const metadata = typeof metadataResponse === 'string' ? JSON.parse(metadataResponse) : metadataResponse;
  const seedResponse = await ctx.proxiedFetcher<{ seed?: string } | string>(`${API_BASE}/seed`, {
    headers,
    query: { mediaId: String(mediaId) },
  });
  const seed = typeof seedResponse === 'string' ? JSON.parse(seedResponse).seed : seedResponse.seed;
  if (!seed) throw new NotFoundError('No Vidking seed found');

  const title = mediaType === 'movie' ? metadata.title : metadata.name;
  const date = mediaType === 'movie' ? metadata.release_date : metadata.first_air_date;
  const payload = await ctx.proxiedFetcher<string>(`${API_BASE}/cdn/sources-with-title`, {
    headers: {
      ...headers,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
    },
    query: {
      title,
      mediaType,
      year: date?.slice(0, 4) || '',
      episodeId: ctx.media.type === 'show' ? String(ctx.media.episode.number) : '1',
      seasonId: ctx.media.type === 'show' ? String(ctx.media.season.number) : '1',
      tmdbId: String(mediaId),
      imdbId: metadata.external_ids?.imdb_id || '',
      enc: '2',
      seed,
      _t: String(Date.now()),
    },
  });
  const data = decryptVidkingPayload(payload, seed, mediaId);
  const streams = mapVidkingStreams(data, ctx.features);
  if (streams.length === 0) throw new NotFoundError('No Vidking streams found');
  return { embeds: [], stream: streams };
}

export const vidkingScraper = makeSourcerer({
  id: 'vidking',
  name: 'Vidking',
  rank: 998,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper,
  scrapeShow: comboScraper,
});
