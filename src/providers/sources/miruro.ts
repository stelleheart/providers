import { inflate, inflateRaw, ungzip } from 'pako';

import { flags } from '@/entrypoint/utils/targets';
import { makeSourcerer } from '@/providers/base';
import type { SourcererOutput } from '@/providers/base';
import { labelToLanguageCode } from '@/providers/captions';
import { getAnilistIdFromMedia } from '@/utils/anilist';
import type { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';
import { createM3U8ProxyUrl } from '@/utils/proxy';

import type { CaptionType } from '../captions';

const MIRURO_BASE_URL = 'https://miruro.to';
const MIRURO_PIPE_PATH = '/api/secure/pipe';
const MIRURO_VERSION = '0.2.0';
const MIRURO_SOURCE_TIMEOUT_MS = 4500;
const MIRURO_XOR_KEY = new Uint8Array(
  ('71951034f8fbcf53d89db52ceb3dc22c'.match(/.{2}/g) || []).map((part) => parseInt(part, 16)),
);

type ScrapeCtx = ShowScrapeContext | MovieScrapeContext;
type CompressionKind = 'gzip' | 'zlib' | 'raw';

type MiruroConfigResponse = {
  streaming?: Record<string, { visible?: boolean, capabilities: {sub: boolean, ssub: boolean} }>;
  providerOrder?: string[];
};

type MiruroEpisode = {
  id?: string;
  number?: number;
  audio?: string;
};

type MiruroEpisodesResponse = {
  providers?: Record<
    string,
    {
      episodes?: Record<string, MiruroEpisode[]>;
    }
  >;
};

type MiruroSourceEntry = {
  url?: string;
  type?: string;
  referer?: string;
};

type MiruroSubtitleEntry = {
  file?: string;
  label?: string;
  language?: string;
  format?: string;
};

type MiruroSourcesResponse = {
  streams?: MiruroSourceEntry[];
  subtitles?: MiruroSubtitleEntry[];
};

type EpisodeCandidate = {
  id: string;
  audio?: string;
  providerId: string;
};

type CategoryPick = {
  stream: NonNullable<SourcererOutput['stream']>[number];
  hasCaptions: boolean;
};

const ISO6391_TO_6392: Record<string, string> = {
  ar: 'ara',
  bg: 'bul',
  bn: 'ben',
  bs: 'bos',
  cs: 'ces',
  da: 'dan',
  de: 'deu',
  el: 'ell',
  en: 'eng',
  es: 'spa',
  et: 'est',
  fa: 'fas',
  fi: 'fin',
  fr: 'fra',
  he: 'heb',
  hr: 'hrv',
  hu: 'hun',
  id: 'ind',
  it: 'ita',
  ja: 'jpn',
  ko: 'kor',
  nl: 'nld',
  no: 'nor',
  pl: 'pol',
  pt: 'por',
  ro: 'ron',
  ru: 'rus',
  sl: 'slv',
  sr: 'srp',
  sv: 'swe',
  th: 'tha',
  tl: 'tgl',
  tr: 'tur',
  ur: 'urd',
  zh: 'zho',
};

function toBase64UrlJson(value: unknown): string {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function xorBytes(bytes: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length === 0) throw new Error('Miruro XOR key is empty');

  const output = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    output[i] = bytes[i] ^ key[i % key.length];
  }

  return output;
}

function detectCompression(bytes: Uint8Array): CompressionKind {
  const isGzip = bytes.length >= 3 && bytes[0] === 31 && bytes[1] === 139 && bytes[2] === 8;
  if (isGzip) return 'gzip';

  const isZlib =
    bytes.length >= 2 &&
    (bytes[0] & 15) === 8 &&
    (bytes[0] >> 4) <= 7 &&
    (((bytes[0] << 8) | bytes[1]) % 31 === 0);
  if (isZlib) return 'zlib';

  return 'raw';
}

function decompress(bytes: Uint8Array, kind: CompressionKind): Uint8Array {
  if (kind === 'gzip') return ungzip(bytes) as Uint8Array;
  if (kind === 'zlib') return inflate(bytes) as Uint8Array;
  return inflateRaw(bytes) as Uint8Array;
}

function decodeMiruroBody(body: string, obfuscatedHeader: string | null): unknown {
  if (obfuscatedHeader === null) {
    return JSON.parse(body);
  }

  let bytes = base64UrlToBytes(body);
  if (obfuscatedHeader === '2') {
    bytes = xorBytes(bytes, MIRURO_XOR_KEY);
  }

  const compression = detectCompression(bytes);
  const inflated = decompress(bytes, compression);
  const decoded = new TextDecoder('utf-8').decode(inflated);

  return JSON.parse(decoded);
}

async function miruroPipeRequest<T>(
  ctx: ScrapeCtx,
  path: string,
  query: Record<string, string | number>,
  timeoutMs?: number,
): Promise<T> {
  const encodedRequest = toBase64UrlJson({
    path,
    method: 'GET',
    query,
    body: null,
    version: MIRURO_VERSION,
  });

  const response = await ctx.proxiedFetcher.full<string | T>(MIRURO_PIPE_PATH, {
    baseUrl: MIRURO_BASE_URL,
    query: { e: encodedRequest },
    headers: {
      Referer: `${MIRURO_BASE_URL}/`,
      Origin: MIRURO_BASE_URL,
    },
    readHeaders: ['x-obfuscated'],
    timeoutMs,
  });

  if (typeof response.body !== 'string') {
    return response.body as T;
  }

  return decodeMiruroBody(response.body, response.headers.get('x-obfuscated')) as T;
}

function normalizeCategory(category: string): string {
  return category.trim().toLowerCase();
}

function getProviderOrder(config: MiruroConfigResponse): string[] {
  const preferredOrder = config.providerOrder ?? [];
  const fallbackOrder = Object.keys(config.streaming ?? {});
  const candidates = preferredOrder.length > 0 ? preferredOrder : fallbackOrder;

  return candidates.filter((providerId) => config.streaming?.[providerId]?.visible !== false);
}

function collectEpisodeCandidatesByCategory(
  episodesResponse: MiruroEpisodesResponse,
  targetEpisode: number,
): Record<string, EpisodeCandidate[]> {
  const output: Record<string, EpisodeCandidate[]> = {};

  for (const [providerId, provider] of Object.entries(episodesResponse.providers ?? {})) {
    for (const [category, episodes] of Object.entries(provider.episodes ?? {})) {
      const normalizedCategory = normalizeCategory(category);
      const matches = episodes.filter((episode) => episode?.number === targetEpisode && !!episode?.id);

      if (matches.length === 0) continue;
      if (!output[normalizedCategory]) {
        output[normalizedCategory] = [];
      }

      for (const match of matches) {
        const id = match.id as string;
        if (
          !output[normalizedCategory].some(
            (candidate) => candidate.id === id && candidate.providerId === providerId,
          )
        ) {
          output[normalizedCategory].push({
            id,
            audio: match.audio,
            providerId,
          });
        }
      }
    }
  }

  return output;
}

function toIso6392(codeOrLabel: string): string {
  const normalized = codeOrLabel.trim().toLowerCase();
  if (/^[a-z]{3}$/i.test(normalized)) return normalized;

  const primary = normalized.split('-')[0];
  if (/^[a-z]{2}$/i.test(primary)) {
    return ISO6391_TO_6392[primary] ?? 'und';
  }

  const mapped = labelToLanguageCode(codeOrLabel) || labelToLanguageCode(normalized);
  if (!mapped) return 'und';

  const mappedPrimary = mapped.toLowerCase().split('-')[0];
  return ISO6391_TO_6392[mappedPrimary] ?? 'und';
}

function resolveLanguageCode(category: string, episodeAudio?: string): string {
  const normalized = category.toLowerCase();
  if (normalized === 'ssub' || normalized === 'sub') return 'jpn';
  if (normalized === 'dub') return 'eng';

  return toIso6392(episodeAudio || category);
}

function inferCaptionType(url: string, format?: string): CaptionType {
  const normalizedFormat = format?.toLowerCase();
  if (normalizedFormat === 'srt' || url.toLowerCase().includes('.srt')) {
    return 'srt';
  }
  return 'vtt';
}

function mapCaptionLanguage(subtitle: MiruroSubtitleEntry): string {
  const candidate = subtitle.language?.trim();
  const normalized = candidate?.toLowerCase();
  if (normalized && /^[a-z]{2}(-[a-z]{2})?$/i.test(normalized)) {
    return normalized;
  }

  return (labelToLanguageCode(candidate || subtitle.label || '') || 'unknown').toLowerCase();
}

function getOriginFromReferer(referer?: string): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

function mapSourceToStream(
  ctx: ScrapeCtx,
  category: string,
  episode: EpisodeCandidate,
  sourcesData: MiruroSourcesResponse,
): CategoryPick | undefined {
  const streams = sourcesData.streams ?? [];
  const hls = streams.find((stream) => stream.url && stream.type?.toLowerCase() === 'hls');
  const file = streams.find((stream) => {
    const type = stream.type?.toLowerCase();
    return stream.url && type !== 'embed' && type !== 'hls';
  });

  const selected = hls || file;
  if (!selected?.url) return undefined;

  const captions = (sourcesData.subtitles ?? [])
    .filter((subtitle) => !!subtitle.file)
    .map((subtitle) => ({
      id: subtitle.file as string,
      url: subtitle.file as string,
      language: mapCaptionLanguage(subtitle),
      type: inferCaptionType(subtitle.file as string, subtitle.format),
      hasCorsRestrictions: false,
    }));

  const referer = selected.referer || streams.find((stream) => !!stream.referer)?.referer || `${MIRURO_BASE_URL}/`;
  const origin = getOriginFromReferer(referer) || MIRURO_BASE_URL;
  const streamHeaders: Record<string, string> = {};
  if (referer) streamHeaders.Referer = referer;
  if (origin) streamHeaders.Origin = origin;

  const language = resolveLanguageCode(category, episode.audio);

  if (hls?.url) {
    return {
      stream: {
        id: `miruro-${language}-${category}-hls`,
        language,
        type: 'hls',
        playlist: createM3U8ProxyUrl(hls.url, ctx.features, streamHeaders),
        headers: Object.keys(streamHeaders).length > 0 ? streamHeaders : undefined,
        proxyDepth: 2,
        captions,
        flags: [flags.CORS_ALLOWED],
      },
      hasCaptions: captions.length > 0,
    };
  }

  return {
    stream: {
      id: `miruro-${language}-${category}-file`,
      language,
      type: 'file',
      qualities: {
        unknown: {
          type: 'mp4',
          url: selected.url,
        },
      },
      headers: Object.keys(streamHeaders).length > 0 ? streamHeaders : undefined,
      captions,
      flags: [flags.CORS_ALLOWED],
    },
    hasCaptions: captions.length > 0,
  };
}

type SourceAttemptCache = Map<string, MiruroSourcesResponse | undefined>;

function getSourceAttemptCacheKey(category: string, providerId: string, episodeId: string): string {
  return `${category}::${providerId}::${episodeId}`;
}

async function getSourcesForAttempt(
  ctx: ScrapeCtx,
  category: string,
  providerId: string,
  episodeId: string,
  anilistId: number,
  cache: SourceAttemptCache,
): Promise<MiruroSourcesResponse | undefined> {
  const key = getSourceAttemptCacheKey(category, providerId, episodeId);
  if (cache.has(key)) return cache.get(key);

  try {
    const data = await miruroPipeRequest<MiruroSourcesResponse>(
      ctx,
      'sources',
      {
        episodeId,
        provider: providerId,
        category,
        anilistId: String(anilistId),
      },
      MIRURO_SOURCE_TIMEOUT_MS,
    );

    cache.set(key, data);
    return data;
  } catch {
    cache.set(key, undefined);
    return undefined;
  }
}

async function resolveCategoryStream(
  ctx: ScrapeCtx,
  providers: string[],
  category: string,
  episodeCandidates: EpisodeCandidate[],
  anilistId: number,
  sourceAttemptCache: SourceAttemptCache,
): Promise<CategoryPick | undefined> {
  let firstPlayable: CategoryPick | undefined;

  for (const providerId of providers) {
    let providerPlayable: CategoryPick | undefined;
    const providerEpisodes = episodeCandidates.filter((episode) => episode.providerId === providerId);
    if (providerEpisodes.length === 0) continue;

    for (const episode of providerEpisodes) {
      const sourcesData = await getSourcesForAttempt(
        ctx,
        category,
        providerId,
        episode.id,
        anilistId,
        sourceAttemptCache,
      );
      if (!sourcesData) continue;

      const mapped = mapSourceToStream(ctx, category, episode, sourcesData);
      if (!mapped) continue;

      if (!providerPlayable) {
        providerPlayable = mapped;
      }
      if (mapped.hasCaptions) {
        return mapped;
      }
    }

    if (!firstPlayable && providerPlayable) {
      firstPlayable = providerPlayable;
    }
  }

  if (firstPlayable) {
    return firstPlayable;
  }

  // Fallback: some titles expose episode IDs that only work with their own provider key.
  // Keep provider-order as primary strategy, but try candidate-origin provider as recovery.
  const fallbackProviders = Array.from(new Set(episodeCandidates.map((candidate) => candidate.providerId))).filter(
    (providerId) => !!providerId,
  );

  for (const providerId of fallbackProviders) {
    const providerEpisodes = episodeCandidates.filter((episode) => episode.providerId === providerId);
    for (const episode of providerEpisodes) {
      const sourcesData = await getSourcesForAttempt(
        ctx,
        category,
        providerId,
        episode.id,
        anilistId,
        sourceAttemptCache,
      );
      if (!sourcesData) continue;

      const mapped = mapSourceToStream(ctx, category, episode, sourcesData);
      if (mapped) {
        return mapped;
      }
    }
  }

  return undefined;
}

async function scrapeMiruro(ctx: ScrapeCtx): Promise<SourcererOutput> {
  ctx.progress(5);

  const targetEpisode = ctx.media.type === 'movie' ? 1 : ctx.media.episode.number;
  const anilistId = await getAnilistIdFromMedia(ctx, ctx.media);
  ctx.progress(15);

  const config = await miruroPipeRequest<MiruroConfigResponse>(ctx, 'config', {});
  ctx.progress(25);

  const episodesResponse = await miruroPipeRequest<MiruroEpisodesResponse>(ctx, 'episodes', {
    anilistId: String(anilistId),
  });
  ctx.progress(35);

  const providers = getProviderOrder(config);
  console.debug(`[Miruro] Providers in order: ${providers.join(', ')}`);
  if (providers.length === 0) {
    throw new NotFoundError('Miruro returned no streaming providers');
  }

  const episodesByCategory = collectEpisodeCandidatesByCategory(episodesResponse, targetEpisode);
  console.debug(`[Miruro] Episodes by category: ${JSON.stringify(episodesByCategory)}`);

  if (Object.keys(episodesByCategory).length === 0) {
    throw new NotFoundError(`Miruro episode ${targetEpisode} was not found`);
  }
  ctx.progress(45);

  const outputStreams: NonNullable<SourcererOutput['stream']> = [];
  const sourceAttemptCache: SourceAttemptCache = new Map();

  const japaneseCategory = episodesByCategory.ssub?.length ? 'ssub' : 'sub';
  const japaneseEpisodes = episodesByCategory[japaneseCategory] ?? [];
  console.debug(`[Miruro] Japanese episode candidates: ${JSON.stringify(japaneseEpisodes)} (category: ${japaneseCategory})`);
  if (japaneseEpisodes.length > 0) {
    const japanese = await resolveCategoryStream(
      ctx,
      providers,
      japaneseCategory,
      japaneseEpisodes,
      anilistId,
      sourceAttemptCache,
    );
    if (japanese) {
      outputStreams.push(japanese.stream);
    }
  }
  ctx.progress(70);

  const dubEpisodes = episodesByCategory.dub ?? [];
  console.debug(`[Miruro] Dub episode candidates: ${JSON.stringify(dubEpisodes)}`);
  if (dubEpisodes.length > 0) {
    const dub = await resolveCategoryStream(ctx, providers, 'dub', dubEpisodes, anilistId, sourceAttemptCache);
    if (dub) {
      outputStreams.push(dub.stream);
    }
  }
  ctx.progress(90);

  if (outputStreams.length === 0) {
    throw new NotFoundError('Miruro did not return playable streams');
  }

  ctx.progress(98);
  console.debug(`[Miruro] Selected streams: ${JSON.stringify(outputStreams)}`);
  return {
    embeds: [],
    stream: outputStreams,
  };
}

export const miruroScraper = makeSourcerer({
  id: 'mirurov2',
  name: 'Miruro',
  rank: 999,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: scrapeMiruro,
  scrapeShow: scrapeMiruro,
});
