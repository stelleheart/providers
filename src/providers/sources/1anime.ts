import { XChaCha20Poly1305 } from '@stablelib/xchacha20poly1305';
import { twofish } from 'twofish';

import { flags } from '@/entrypoint/utils/targets';
import { makeSourcerer } from '@/providers/base';
import type { SourcererOutput } from '@/providers/base';
import type { Qualities, StreamFile } from '@/providers/streams';
import { getAnilistIdFromMedia } from '@/utils/anilist';
import type { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';
import { createM3U8ProxyUrl } from '@/utils/proxy';

function base64ToBytes(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, 'base64'));
}

const ONEANIME_API_BASE = 'https://1anime.app/api';
const ONEANIME_STREAM_TIMEOUT_MS = 45000;
const PROVIDERS_IN_ORDER = ['ZenV2', 'Zen', 'PaheV2', 'Pahe', 'Kiwi', 'Gogo', 'Kai', 'Zone', 'Nexus'] as const;
const SUB_OR_DUB_ORDER = ['s', 'd'] as const;

const TWOFISH_KEY = base64ToBytes('aBwDLkNM5v5kPVEWTSOhJZpzWooaRjFTgBTJGfjIf6M=');
const XCHACHA_KEY = base64ToBytes('i9RmtcQwwLna5C6TlEJ58fHVtU2MHuajPxosbntOCC0=');
const XOR_KEYS = [
  'Rc1T3cV0m+q/ulaUm+sm/inoPtTptyXeYI74ZWO0Odw=',
  'CtngWQj0f6DGy5DvvFyOOt9fuzTar9PlZACmRnApX+Tl7A3BZIweYWj6uQsZPn9nSYGCE+RcDRj+Sn+G9T782w==',
  'AA/tStWf9S94ilDSB/uEzfFavhSaHilZmutx7hKQ9n19VdezrF9sU8RG3USWuIdn',
  'myDM5TPmJop83duV/urUgTJH6RdM1uaZY2lnk77x4iNMqOs2kNhbwqf+H/eYz4Qxy7MKmBfZloxdgwlPeYjxIOQxNaYc3A4i3Ta9QdBRobYH5kp7DOvkJnnEPP67OtaToGjhyqJUWSzAE21P1rS3sG8dlMhQNH0S09uOn7+TGQc=',
  'lC5r3hdWwy6vbI/bRr+r6S1xvyeDVrj3INKFjHVXIPBnu+mah29p53IDtsEYdm+bkvQN4v2VlzKvaTBjHw/jrZLE1VCU+ZpOVUGTOaFBCQ1sbFXtU2fRr7TcnEzN2Sgq',
  'JQYY3/3bWRhcoFW7Y26qmwxYGUuiNA5zokRGaUexREt3hVFWSvtLsvzd3TCpZdBtQdWtozTvmpaDH2B8CtCK5Z9ffWPd8avL',
  'qkZa0nZ9GCPy4upxAF9/a4XMgvGOQj9rfLk9prAcJJ/YD8XpL0jQpfRqJOfAtQmzX60ZOKlNhRI=',
  'rGZ34YXUrv+RKuaNu+t61oqzm/rnEwxLXgA/gKazuPsjUzpgVr2OQwXMz50LR5Z4QDuBg/1nIoXI4kaVeLiHq/faTN2fqv8BcvqNWY3qGVkz3GG87Ie65wZUP16Hs5VyS+4/qf3rWJY=',
].map(base64ToBytes);

const UNSUPPORTED_HLS_AUDIO_CODECS = ['mp4a.40.1'];

type ScrapeCtx = ShowScrapeContext | MovieScrapeContext;
type LanguageBucket = 'jpn' | 'eng';

type StreamRawResponse = {
  result?: string;
};

type DecryptedStreamPayload = {
  sources?: Array<{
    url: string;
    quality: string;
    isM3U8: boolean;
  }>;
  headers?: {
    Referer?: string;
  };
};

type FoundProviderStreams = {
  providerName: string;
  streamsByLanguage: Partial<Record<LanguageBucket, DecryptedStreamPayload>>;
};

function rot13(input: string): string {
  return input.replace(/[A-Za-z]/g, (char) => {
    const base = char <= 'Z' ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function parseQualityLabel(quality: string): Qualities {
  const match = quality.match(/(360|480|720|1080|2160)p/i);
  if (!match) return 'unknown';

  const value = match[1];
  if (value === '2160') return '4k';
  if (value === '360' || value === '480' || value === '720' || value === '1080') return value;
  return 'unknown';
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

function incrementCounter(counter: Uint8Array) {
  for (let i = counter.length - 1; i >= 0; i -= 1) {
    counter[i] = (counter[i] + 1) & 0xff;
    if (counter[i] !== 0) break;
  }
}

function rotateRight(input: Uint8Array, shift: number): Uint8Array {
  if (shift === 0) return new Uint8Array(input);
  const out = new Uint8Array(input.length);

  for (let i = 0; i < input.length; i += 1) {
    const value = input[i];
    out[i] = ((value >> shift) | (value << (8 - shift))) & 0xff;
  }

  return out;
}

function rotateLeft(input: Uint8Array, shift: number): Uint8Array {
  if (shift === 0) return new Uint8Array(input);
  const out = new Uint8Array(input.length);

  for (let i = 0; i < input.length; i += 1) {
    const value = input[i];
    out[i] = ((value << shift) | (value >> (8 - shift))) & 0xff;
  }

  return out;
}

function xorWithKey(input: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length);

  for (let i = 0; i < input.length; i += 1) {
    out[i] = input[i] ^ key[i % key.length];
  }

  return out;
}

function decryptTwofishCtr(input: Uint8Array): Uint8Array {
  if (input.length <= 16) {
    throw new NotFoundError('1Anime stream payload is too short for Twofish CTR');
  }

  const counter = input.slice(0, 16);
  const encrypted = input.slice(16);
  const out = new Uint8Array(encrypted.length);
  const cipher = twofish([]);

  for (let offset = 0; offset < encrypted.length; offset += 16) {
    const keystream = cipher.encrypt(Array.from(TWOFISH_KEY), Array.from(counter));
    const blockEnd = Math.min(offset + 16, encrypted.length);

    for (let i = offset; i < blockEnd; i += 1) {
      out[i] = encrypted[i] ^ keystream[i - offset];
    }

    incrementCounter(counter);
  }

  return out;
}

function decryptMultiXor(input: Uint8Array): Uint8Array {
  let result: Uint8Array<ArrayBufferLike> = new Uint8Array(input);

  for (let i = XOR_KEYS.length - 1; i >= 0; i -= 1) {
    const shift = (i + 1) % 8;
    result = i % 2 === 0 ? rotateRight(result, shift) : rotateLeft(result, shift);
    result = xorWithKey(result, XOR_KEYS[i]);
  }

  return result;
}

function decryptXChaCha(input: Uint8Array): Uint8Array {
  if (input.length <= 24) {
    throw new NotFoundError('1Anime stream payload is too short for XChaCha20-Poly1305');
  }

  const nonce = input.slice(0, 24);
  const ciphertextWithTag = input.slice(24);
  const xchacha = new XChaCha20Poly1305(XCHACHA_KEY);
  const opened = xchacha.open(nonce, ciphertextWithTag);

  if (!opened) {
    throw new NotFoundError('1Anime stream payload authentication failed');
  }

  return opened;
}

function decodeStreamBlob(result: string): DecryptedStreamPayload {
  const afterFirstBase64 = Buffer.from(result, 'base64').toString('utf8');
  const afterRot13 = rot13(afterFirstBase64);
  const afterURIComponent = decodeURIComponent(afterRot13);
  const afterSecondBase64 = base64ToBytes(afterURIComponent);
  const afterTwofish = decryptTwofishCtr(afterSecondBase64);
  const afterXor = decryptMultiXor(afterTwofish);
  const plaintextBytes = decryptXChaCha(afterXor);
  const plaintext = new TextDecoder().decode(plaintextBytes);

  return JSON.parse(plaintext) as DecryptedStreamPayload;
}

async function fetchJson<T>(
  ctx: ScrapeCtx,
  url: string,
  options?: { method?: 'GET' | 'POST'; body?: string; timeoutMs?: number },
): Promise<T> {
  const response = await ctx.proxiedFetcher<T | string>(url, {
    method: options?.method,
    body: options?.body,
    timeoutMs: options?.timeoutMs,
    headers: options?.body
      ? {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        }
      : undefined,
  });

  if (typeof response === 'string') {
    const trimmed = response.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return JSON.parse(trimmed) as T;
    }
    throw new NotFoundError('1Anime API returned an unexpected response body');
  }

  if (!response || typeof response !== 'object') {
    throw new NotFoundError('1Anime API returned an empty response');
  }

  return response as T;
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

    const manifest =
      typeof manifestResponse.body === 'string' ? manifestResponse.body : String(manifestResponse.body ?? '');

    if (!manifest) return true;

    const declaredCodecs = getDeclaredCodecsFromManifest(manifest);
    if (declaredCodecs.length === 0) return true;

    return !declaredCodecs.some((codec) =>
      UNSUPPORTED_HLS_AUDIO_CODECS.some((unsupported) => codec.includes(unsupported)),
    );
  } catch {
    return true;
  }
}

async function tryProviderMode(
  ctx: ScrapeCtx,
  args: {
    anilistId: number;
    providerName: string;
    episodeNumber: number;
    subOrDub: 's' | 'd';
  },
): Promise<DecryptedStreamPayload | null> {
  const endpoint =
    `${ONEANIME_API_BASE}/stream?anilistId=${args.anilistId}` +
    `&providerName=${encodeURIComponent(args.providerName)}` +
    `&episodeNumber=${args.episodeNumber}` +
    `&subOrDub=${args.subOrDub}`;

  const raw = await fetchJson<StreamRawResponse>(ctx, endpoint, {
    timeoutMs: ONEANIME_STREAM_TIMEOUT_MS,
  });
  if (!raw.result) return null;

  try {
    const payload = decodeStreamBlob(raw.result);
    if (!payload.sources?.some((source) => !!source?.url)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

async function findWorkingProvider(
  ctx: ScrapeCtx,
  args: {
    anilistId: number;
    episodeNumber: number;
  },
): Promise<FoundProviderStreams> {
  const enabledModes: Array<'s' | 'd'> = [...SUB_OR_DUB_ORDER];

  for (const providerName of PROVIDERS_IN_ORDER) {
    const streamsByLanguage: FoundProviderStreams['streamsByLanguage'] = {};

    for (const subOrDub of enabledModes) {
      const payload = await tryProviderMode(ctx, {
        anilistId: args.anilistId,
        providerName,
        episodeNumber: args.episodeNumber,
        subOrDub,
      });

      if (!payload) continue;
      const language = subOrDub === 'd' ? 'eng' : 'jpn';
      streamsByLanguage[language] = payload;
    }

    if (streamsByLanguage.jpn || streamsByLanguage.eng) {
      return { providerName, streamsByLanguage };
    }
  }

  throw new NotFoundError('No playable 1Anime streams found across providers');
}

async function scrape1anime(ctx: ScrapeCtx): Promise<SourcererOutput> {
  ctx.progress(15);
  const anilistId = await getAnilistIdFromMedia(ctx, ctx.media);

  ctx.progress(35);
  const episodeNumber = ctx.media.type === 'movie' ? 1 : ctx.media.episode.number;

  ctx.progress(60);
  const found = await findWorkingProvider(ctx, {
    anilistId,
    episodeNumber,
  });

  const hlsStreams: NonNullable<SourcererOutput['stream']> = [];
  const fileStreams: NonNullable<SourcererOutput['stream']> = [];

  for (const [language, payload] of Object.entries(found.streamsByLanguage) as Array<
    [LanguageBucket, DecryptedStreamPayload]
  >) {
    if (!payload?.sources?.length) continue;

    const referer = payload.headers?.Referer;
    let origin: string | undefined;
    if (referer) {
      try {
        origin = new URL(referer).origin;
      } catch {
        // ignore invalid referer
      }
    }

    const hlsByLanguage: { quality: Qualities; url: string }[] = [];
    const fileByQuality: Partial<Record<Qualities, StreamFile>> = {};

    for (const source of payload.sources) {
      if (!source?.url) continue;

      const quality = parseQualityLabel(source.quality ?? '');
      if (source.isM3U8) {
        hlsByLanguage.push({ quality, url: source.url });
      } else if (!fileByQuality[quality]) {
        fileByQuality[quality] = {
          type: 'mp4',
          url: source.url,
        };
      }
    }

    const bestHls = hlsByLanguage.sort((a, b) => qualityPriority(b.quality) - qualityPriority(a.quality))[0];
    if (bestHls) {
      const streamHeaders: Record<string, string> = {};
      if (referer) streamHeaders.Referer = referer;
      if (origin) streamHeaders.Origin = origin;

      const supported = await isSupportedHlsPlaylist(ctx, bestHls.url, streamHeaders);
      if (supported) {
        hlsStreams.push({
          id: language === 'eng' ? 'eng-audio' : 'jpn-audio',
          type: 'hls',
          playlist: createM3U8ProxyUrl(bestHls.url, ctx.features, streamHeaders),
          headers: Object.keys(streamHeaders).length ? streamHeaders : undefined,
          proxyDepth: 2,
          captions: [],
          flags: [flags.CORS_ALLOWED],
        });
      }
    }

    if (Object.keys(fileByQuality).length > 0) {
      fileStreams.push({
        id: language === 'eng' ? 'eng-audio-file' : 'jpn-audio-file',
        type: 'file',
        qualities: fileByQuality,
        headers: referer ? { Referer: referer } : undefined,
        captions: [],
        flags: [flags.CORS_ALLOWED],
      });
    }
  }

  if (hlsStreams.length > 0) {
    ctx.progress(95);
    return {
      embeds: [],
      stream: [...hlsStreams, ...fileStreams],
    };
  }

  if (fileStreams.length > 0) {
    ctx.progress(95);
    return {
      embeds: [],
      stream: fileStreams,
    };
  }

  throw new NotFoundError(`No stream files were produced by 1Anime provider ${found.providerName}`);
}

export const oneanimeScraper = makeSourcerer({
  id: '1anime',
  name: '1Anime 🔥',
  rank: 301,
  disabled: false,
  flags: [flags.CORS_ALLOWED],
  scrapeShow: scrape1anime,
  scrapeMovie: scrape1anime,
});
