import { flags } from '@/entrypoint/utils/targets';
import { SourcererOutput, makeSourcerer } from '@/providers/base';
import { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';

const BASE_URL = 'https://goated.cx';
const encoder = new TextEncoder();
const headers = {
  Origin: BASE_URL,
  Referer: `${BASE_URL}/`,
};

type GoatedKey = CryptoKey;
type GoatedStream = { quality?: string; source?: string; url?: string };
type GoatedResponse = { ok?: boolean; enc?: string; streams?: GoatedStream[]; error?: string };

function parseResponse<T>(value: T | string): T {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function deriveGoatedKey(token: string): Promise<GoatedKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(token), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('goated-stream-salt'),
      info: encoder.encode('goated-api-v1'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptGoatedPayload(data: Record<string, string>, key: GoatedKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(data))),
  );
  const payload = new Uint8Array(iv.length + encrypted.length);
  payload.set(iv);
  payload.set(encrypted, iv.length);
  return encodeBase64(payload);
}

export async function decryptGoatedPayload(payload: string, key: GoatedKey): Promise<string> {
  const bytes = decodeBase64(payload);
  return new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12)),
  );
}

function leadingZeroBits(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) {
    if (byte === 0) count += 8;
    else return count + Math.clz32(byte) - 24;
  }
  return count;
}

async function solveChallenge(challenge: string, difficulty: number): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    const nonce = attempt.toString(36);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${challenge}:${nonce}`)));
    if (leadingZeroBits(digest) >= difficulty) return nonce;
  }
}

async function getSession(ctx: ShowScrapeContext | MovieScrapeContext): Promise<{ token: string; key: GoatedKey }> {
  const challenge = parseResponse(
    await ctx.proxiedFetcher<{ challenge: string; difficulty: number } | string>(`${BASE_URL}/api/auth/challenge`, {
      headers,
    }),
  );
  const nonce = await solveChallenge(challenge.challenge, challenge.difficulty);
  const session = parseResponse(
    await ctx.proxiedFetcher<{ token?: string } | string>(`${BASE_URL}/api/auth/session`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge: challenge.challenge, nonce }),
    }),
  );
  if (!session.token) throw new NotFoundError('Goated authentication failed');
  return { token: session.token, key: await deriveGoatedKey(session.token) };
}

async function comboScraper(ctx: ShowScrapeContext | MovieScrapeContext): Promise<SourcererOutput> {
  const { token, key } = await getSession(ctx);
  const params: Record<string, string> = {
    type: ctx.media.type === 'movie' ? 'movie' : 'tv',
    id: String(ctx.media.tmdbId),
    provider: 'reallyfast',
  };
  if (ctx.media.type === 'show') {
    params.season = String(ctx.media.season.number);
    params.episode = String(ctx.media.episode.number);
  }

  const encryptedParams = await encryptGoatedPayload(params, key);
  const rawResponse = parseResponse(
    await ctx.proxiedFetcher<GoatedResponse | string>(`${BASE_URL}/api/stream`, {
      headers: { ...headers, Authorization: `Bearer ${token}` },
      query: { d: encryptedParams },
    }),
  );
  const response: GoatedResponse = rawResponse.enc
    ? JSON.parse(await decryptGoatedPayload(rawResponse.enc, key))
    : rawResponse;
  if (!response.ok || !response.streams?.length) throw new NotFoundError(response.error || 'No Goated streams found');

  const streams = await Promise.all(
    response.streams.map(async (stream, index) => {
      if (!stream.url) return null;
      let playlist = stream.url;
      if (!playlist.startsWith('http') && !playlist.startsWith('data:')) {
        try {
          playlist = await decryptGoatedPayload(playlist, key);
        } catch {
          return null;
        }
      }
      return {
        id: `goated-${stream.source || stream.quality || index}`,
        type: 'hls' as const,
        playlist,
        captions: [],
        flags: [flags.CORS_ALLOWED],
      };
    }),
  );
  const validStreams = streams.filter((stream) => stream !== null);
  if (validStreams.length === 0) throw new NotFoundError('No valid Goated streams found');
  return { embeds: [], stream: validStreams };
}

export const goatedScraper = makeSourcerer({
  id: 'goated',
  name: 'Goated',
  rank: 997,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper,
  scrapeShow: comboScraper,
});
