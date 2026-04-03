import { flags } from '@/entrypoint/utils/targets';
import { makeSourcerer } from '@/providers/base';
import type { SourcererOutput } from '@/providers/base';
import type { Qualities } from '@/providers/streams';
import type { StreamFile } from '@/providers/streams';
import { getAnilistTitles } from '@/utils/anilist';
import type { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';
import { createM3U8ProxyUrl } from '@/utils/proxy';

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
const UNSUPPORTED_HLS_AUDIO_CODECS = ['mp4a.40.1'];
const TITLE_SUFFIXES_TO_STRIP = ['the movie', 'movie', 'the film', 'film', 'special', 'the series', 'series'] as const;
const MIN_MATCH_CONFIDENCE = 70;
const MAX_CANDIDATES_FOR_INFO_PROBE = 5;

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

function stripKnownSuffixes(title: string): string {
  let cleaned = title.trim();

  for (const suffix of TITLE_SUFFIXES_TO_STRIP) {
    const pattern = new RegExp(`(?:\\s*[:\\-]\\s*)?${suffix}$`, 'i');
    if (pattern.test(cleaned)) {
      cleaned = cleaned.replace(pattern, '').trim();
    }
  }

  return cleaned;
}

function buildTitleAliases(title: string): string[] {
  const aliases = new Set<string>();
  const trimmed = title.trim();

  if (!trimmed) {
    return [];
  }

  const stripped = stripKnownSuffixes(trimmed);
  const colonParts = stripped
    .split(':')
    .map((part) => part.trim())
    .filter(Boolean);

  aliases.add(trimmed);
  aliases.add(stripped);
  for (const part of colonParts) {
    aliases.add(part);
  }

  return [...aliases].filter(Boolean);
}

function tokenizeTitle(input: string): string[] {
  return normalizeTitle(input)
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean);
}

function tokenDiceCoefficient(a: string, b: string): number {
  const aTokens = tokenizeTitle(a);
  const bTokens = tokenizeTitle(b);

  if (!aTokens.length || !bTokens.length) {
    return 0;
  }

  const aCounts = new Map<string, number>();
  const bCounts = new Map<string, number>();

  for (const token of aTokens) {
    aCounts.set(token, (aCounts.get(token) ?? 0) + 1);
  }
  for (const token of bTokens) {
    bCounts.set(token, (bCounts.get(token) ?? 0) + 1);
  }

  let intersection = 0;
  for (const [token, countA] of aCounts.entries()) {
    const countB = bCounts.get(token) ?? 0;
    intersection += Math.min(countA, countB);
  }

  return (2 * intersection) / (aTokens.length + bTokens.length);
}

function scoreTitleMatch(alias: string, candidateTitle: string): number {
  const normalizedAlias = normalizeTitle(alias);
  const normalizedCandidate = normalizeTitle(candidateTitle);

  if (!normalizedAlias || !normalizedCandidate) {
    return 0;
  }

  if (normalizedAlias === normalizedCandidate) {
    return 120;
  }

  let score = tokenDiceCoefficient(normalizedAlias, normalizedCandidate) * 100;
  if (normalizedCandidate.includes(normalizedAlias) || normalizedAlias.includes(normalizedCandidate)) {
    score += 12;
  }

  return score;
}

function scoreYearMatch(targetYear: number, candidateYear?: number): number {
  if (!candidateYear) {
    return 0;
  }

  const diff = Math.abs(candidateYear - targetYear);
  if (diff === 0) {
    return 30;
  }
  if (diff === 1) {
    return 18;
  }
  if (diff === 2) {
    return 8;
  }

  return -Math.min(20, diff * 4);
}

function scoreTypeHint(mediaType: ScrapeCtx['media']['type'], candidateType?: string): number {
  if (!candidateType) {
    return 0;
  }

  const normalized = candidateType.toLowerCase();
  if (mediaType === 'movie') {
    return normalized.includes('movie') ? 15 : -10;
  }

  if (normalized.includes('tv') || normalized.includes('series') || normalized.includes('ona') || normalized.includes('ova')) {
    return 15;
  }

  return -10;
}

function scoreEpisodeCountMatch(media: ScrapeCtx['media'], candidateEpisodeCount: number): number {
  const targetEpisodeCount = media.type === 'movie' ? 1 : media.season.episodeCount;
  if (!targetEpisodeCount) {
    return 0;
  }

  const diff = Math.abs(targetEpisodeCount - candidateEpisodeCount);
  if (diff === 0) {
    return 20;
  }
  if (diff <= 2) {
    return 12;
  }
  if (diff <= 5) {
    return 5;
  }

  return -Math.min(15, diff);
}

function scoreSearchCandidate(item: SearchItem, aliases: string[], media: ScrapeCtx['media']): number {
  let bestTitleScore = 0;
  for (const alias of aliases) {
    const score = scoreTitleMatch(alias, item.title);
    if (score > bestTitleScore) {
      bestTitleScore = score;
    }
  }

  let score = bestTitleScore;
  score += scoreYearMatch(media.releaseYear, item.releaseDate);
  score += scoreTypeHint(media.type, item.type);
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

function qualityPriority(quality: Qualities): number {
  if (quality === '4k') return 2160;
  if (quality === '1080') return 1080;
  if (quality === '720') return 720;
  if (quality === '480') return 480;
  if (quality === '360') return 360;
  return 0;
}

function getDeclaredCodecsFromManifest(manifest: string): string[] {
  const codecs: string[] = [];
  const codecMatches = manifest.matchAll(/codecs\s*=\s*"([^"]+)"/gi);
  for (const match of codecMatches) {
    const value = match[1] ?? '';
    for (const part of value.split(',')) {
      const normalized = part.trim().toLowerCase();
      if (normalized) codecs.push(normalized);
    }
  }

  return codecs;
}

async function isSupportedHlsPlaylist(
  ctx: ScrapeCtx,
  playlistUrl: string,
  headers: Record<string, string>,
): Promise<boolean> {
  try {
    const manifestResponse = await ctx.proxiedFetcher.full(playlistUrl, {
      method: 'GET',
      headers,
    });

    const manifest = typeof manifestResponse.body === 'string' ? manifestResponse.body : String(manifestResponse.body ?? '');
    if (!manifest) return true;

    const declaredCodecs = getDeclaredCodecsFromManifest(manifest);
    if (declaredCodecs.length === 0) {
      // No codec signaling is common on these streams; do not block by default.
      return true;
    }

    return !declaredCodecs.some((codec) => UNSUPPORTED_HLS_AUDIO_CODECS.some((unsupported) => codec.includes(unsupported)));
  } catch {
    // If probing fails, keep the source and let runtime/stream validation decide.
    return true;
  }
}

async function fetchJson<T>(ctx: ScrapeCtx, url: string): Promise<T> {
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
  const aliases = new Set<string>(buildTitleAliases(ctx.media.title));
  try {
    const anilistTitles = await getAnilistTitles(ctx, ctx.media);
    for (const title of anilistTitles) {
      for (const alias of buildTitleAliases(title)) {
        aliases.add(alias);
      }
    }
  } catch {
    // Keep matching resilient even if AniList title enrichment fails.
  }

  const searchAliases = [...aliases];
  if (!searchAliases.length) {
    throw new NotFoundError('Anime not found on 1Anime Pahe');
  }

  const byId = new Map<string, SearchItem>();
  for (const alias of searchAliases) {
    const queryPath = buildSearchPath(alias);
    const response = await fetchJson<SearchResponse>(ctx, `${API_BASE_URL}/${queryPath}`);
    const candidates = response.results ?? [];

    for (const candidate of candidates) {
      if (candidate?.id) {
        byId.set(candidate.id, candidate);
      }
    }
  }

  const dedupedCandidates = [...byId.values()];
  if (!dedupedCandidates.length) {
    throw new NotFoundError('Anime not found on 1Anime Pahe');
  }

  const scored = dedupedCandidates
    .map((item) => ({ item, score: scoreSearchCandidate(item, searchAliases, ctx.media) }))
    .sort((a, b) => b.score - a.score);

  const refined = [...scored];
  const targetEpisodeNumber = ctx.media.type === 'movie' ? 1 : ctx.media.episode.number;
  for (const candidate of refined.slice(0, MAX_CANDIDATES_FOR_INFO_PROBE)) {
    try {
      const info = await fetchJson<InfoResponse>(ctx, `${API_BASE_URL}/info/${encodeURIComponent(candidate.item.id)}`);
      const episodes = info.episodes ?? [];
      if (!episodes.length) {
        continue;
      }

      candidate.score += scoreEpisodeCountMatch(ctx.media, episodes.length);
      const hasTargetEpisode = episodes.some((entry) => entry.number === targetEpisodeNumber);
      if (hasTargetEpisode) {
        candidate.score += 15;
      } else {
        candidate.score -= 10;
      }
    } catch {
      // Ignore info probing failures and keep base score.
    }
  }

  refined.sort((a, b) => b.score - a.score);
  const best = refined[0];

  if (!best || best.score < MIN_MATCH_CONFIDENCE) {
    throw new NotFoundError('No usable anime result on 1Anime Pahe');
  }

  return best.item.id;
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
  let hlsOrigin: string | undefined;
  if (hlsReferer) {
    try {
      hlsOrigin = new URL(hlsReferer).origin;
    } catch {
      // ignore invalid referer
    }
  }
  const sources = watch.sources ?? [];
  const downloads = watch.download ?? [];

  const hlsStreams: NonNullable<SourcererOutput['stream']> = [];
  const fileStreams: NonNullable<SourcererOutput['stream']> = [];
  const hlsByLanguage: Partial<Record<LanguageBucket, { quality: Qualities; url: string }>> = {};
  const fileByLanguage: Record<LanguageBucket, Partial<Record<Qualities, StreamFile>>> = {
    jpn: {},
    eng: {},
  };

  for (const source of sources) {
    if (!source?.url) continue;

    const quality = parseQualityLabel(source.quality ?? '');
    const language = inferLanguage(source.quality ?? '', source.isDub);

    if (source.isM3U8) {
      if (!hlsReferer) continue;
      const existing = hlsByLanguage[language];
      if (!existing || qualityPriority(quality) > qualityPriority(existing.quality)) {
        hlsByLanguage[language] = { quality, url: source.url };
      }
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
    const selected = hlsByLanguage[language];
    if (!selected) continue;

    const streamHeaders: Record<string, string> = {};
    if (hlsReferer) streamHeaders.Referer = hlsReferer;
    if (hlsOrigin) streamHeaders.Origin = hlsOrigin;

    const isSupported = await isSupportedHlsPlaylist(ctx, selected.url, streamHeaders);
    if (!isSupported) {
      continue;
    }

    hlsStreams.push({
      id: buildLangStreamId(language),
      type: 'hls',
      playlist: createM3U8ProxyUrl(selected.url, ctx.features, streamHeaders),
      headers: Object.keys(streamHeaders).length ? streamHeaders : undefined,
      // Proxy nested playlists/segments when the runner's proxy path is used.
      proxyDepth: 2,
      captions: [],
      flags: [flags.CORS_ALLOWED],
    });
  }

  for (const language of ['jpn', 'eng'] as const) {
    if (Object.keys(fileByLanguage[language]).length === 0) continue;

    fileStreams.push({
      id: `${buildLangStreamId(language)}-file`,
      type: 'file',
      qualities: fileByLanguage[language],
      captions: [],
      flags: [flags.CORS_ALLOWED],
    });
  }

  // Prefer HLS streams so clients that only expose audio choices for HLS can surface sub/dub variants.
  // Keep file streams as fallback for clients/browsers where the HLS audio codec is unsupported.
  if (hlsStreams.length > 0) {
    ctx.progress(95);
    return {
      embeds: [],
      stream: [...hlsStreams, ...fileStreams],
    };
  }

  if (!fileStreams.length) {
    throw new NotFoundError('No valid streams found on 1Anime Pahe');
  }

  ctx.progress(95);
  return {
    embeds: [],
    stream: fileStreams,
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
