import { XChaCha20Poly1305 } from "@stablelib/xchacha20poly1305";
import { encrypt, makeSession } from "twofish-ts";

import { flags } from "@/entrypoint/utils/targets";
import { makeSourcerer } from "@/providers/base";
import type { SourcererOutput } from "@/providers/base";
import type { Qualities, StreamFile } from "@/providers/streams";
import { getAnilistIdFromMedia } from "@/utils/anilist";
import type { MovieScrapeContext, ShowScrapeContext } from "@/utils/context";
import { NotFoundError } from "@/utils/errors";
import { createM3U8ProxyUrl } from "@/utils/proxy";

function base64ToBytes(input: string): Uint8Array {
	const normalized = input.replace(/\s+/g, "");
	const binary = atob(normalized);
	const bytes = new Uint8Array(binary.length);

	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}

	return bytes;
}

function base64ToUtf8(input: string): string {
	return new TextDecoder().decode(base64ToBytes(input));
}

const ONEANIME_API_BASE = "https://1anime.app/api";
const ONEANIME_STREAM_TIMEOUT_MS = 45000;
const PROVIDERS_IN_ORDER = [
	"ZenV2",
	"Zen",
	"PaheV2",
	"Pahe",
	"Kiwi",
	"Gogo",
	"Kai",
	"Zone",
	"Nexus",
] as const;
const SUB_OR_DUB_ORDER = ["s", "d"] as const;
const RAW_KEYS = JSON.parse('{"h":{"Sn":"UDnjvdBItnYnedQ2wvGb0ms6mtI6tsdc1zLzOURL4Co=","kI":["0Mvvahf2ChlmBesR41s9+n8aZKZnrVjsp2aGUHCymFE=","ociBZoL+c9Z/NrJk9KkTlLNlIx5NQCrQxtwBl7EjZL7zgYiym+SMcTgy5BJxuiBxe6g6CKk+/eONW2kQ86Kwnw==","tIMp7NlLibWEa4nC+LmR3PYCR1vSlSCu9dRdtxS8nf45Fqi/x9z4N7FhfaIhGN2/","AQLjAxlP9+YTSDJ+8k+ZcZVVrXT8tGy6/8bmeDzQ+//+9IdaAeVZVTPUssPpMao6XhqHBdEHQzIy65dj4tTi9p3bhpHkN9meuyZuwIDbquQz8yLL1QND9WJjAa+KeznqE7bkTX/BG5ag3/87q1Jiy+rJuGxIemsYRopM3QFQ3nA=","yEG2xnLrMhUaSzTfNtlpqnmkDkr1W0r3h3RPPJses2ojRY2DAfX6CkP3BLTdSAiiQcMLrG20I3InxjVBdfi8KJ1qAaC5gKaIQoRWOoI/gb09NG788fjbulC/kuwuvBjM","3ZbOpeGISwk1UXsKEjvE81JtVGM+9t/zzTT8C1hPo/EGMVzE4xCi2kMYnnInJjgbmdkLUHPh6X0RGKFO5sRKkvt67zDOOC0k","OOjl9dfCGZB+YbKv/YYOLfjRH6pwiPjoGrQ9sklgZi/bdO4oi6j6s5yZa4JcYqVhYRtWHrGoPHA=","D2KpDTQ+fSQ6PcPHcfmqmIJ7BQJfOslX5mdxKszCEIOuhtxvoRYougAk5EY+bbqw9ynyZ69uQXBQWKe+2EzleEFMA/Pxu5KI3O8jkGyudpw1W//ySiZprJ4rjkS1M70EYE2uD+dz/bg="],"WZ":"rJEM4x2g4frsb01ZI9khXvL9r+83P0wRkEcLk6ka/So="}}');
const TWOFISH_KEY = base64ToBytes(
	RAW_KEYS.h.WZ,
).slice(0, 32);
const TWOFISH_SESSION = makeSession(TWOFISH_KEY);
const XCHACHA_KEY = base64ToBytes(
	RAW_KEYS.h.Sn,
);
const XOR_KEYS = RAW_KEYS.h.kI.map(base64ToBytes);

const UNSUPPORTED_HLS_AUDIO_CODECS = ["mp4a.40.1"];

type ScrapeCtx = ShowScrapeContext | MovieScrapeContext;
type LanguageBucket = "jpn" | "eng";

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

type AnilistFormat =
	| "TV"
	| "TV_SHORT"
	| "MOVIE"
	| "SPECIAL"
	| "OVA"
	| "ONA"
	| "MUSIC"
	| "MANGA"
	| "NOVEL"
	| "ONE_SHOT";

type AnilistSearchMedia = {
	id: number;
	format: AnilistFormat;
	seasonYear?: number;
	episodes?: number;
	title: {
		romaji: string;
		english?: string;
		native?: string;
	};
	synonyms?: string[];
};

type AnilistSearchResponse = {
	data?: {
		Page?: {
			media?: AnilistSearchMedia[];
		};
	};
};

const ANILIST_SEARCH_QUERY = `
query ($search: String!, $type: MediaType) {
  Page(page: 1, perPage: 20) {
    media(search: $search, type: $type, sort: POPULARITY_DESC) {
      id
      format
      seasonYear
      episodes
      title {
        romaji
        english
        native
      }
      synonyms
    }
  }
}
`;

const TITLE_SUFFIXES_TO_STRIP = [
	"the movie",
	"movie",
	"the film",
	"film",
	"the series",
	"series",
	"special",
] as const;

const MIN_ANILIST_CONFIDENCE_SCORE = 70;

function rot13(input: string): string {
	return input.replace(/[A-Za-z]/g, (char) => {
		const base = char <= "Z" ? 65 : 97;
		return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
	});
}

function normalizeMatchTitle(input: string): string {
	return input
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function stripKnownSuffixes(title: string): string {
	let cleaned = title.trim();

	for (const suffix of TITLE_SUFFIXES_TO_STRIP) {
		const pattern = new RegExp(`(?:\\s*[:\\-]\\s*)?${suffix}$`, "i");
		if (pattern.test(cleaned)) {
			cleaned = cleaned.replace(pattern, "").trim();
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
		.split(":")
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
	return normalizeMatchTitle(input)
		.split(" ")
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

function isShowFormat(format: AnilistFormat): boolean {
	return ["TV", "TV_SHORT", "SPECIAL", "OVA", "ONA"].includes(format);
}

function matchesMediaType(
	media: ScrapeCtx["media"],
	candidate: AnilistSearchMedia,
): boolean {
	if (media.type === "movie") {
		return candidate.format === "MOVIE";
	}
	return isShowFormat(candidate.format);
}

function scoreTitleMatch(alias: string, candidateTitle: string): number {
	const normalizedAlias = normalizeMatchTitle(alias);
	const normalizedCandidate = normalizeMatchTitle(candidateTitle);
	if (!normalizedAlias || !normalizedCandidate) {
		return 0;
	}

	if (normalizedAlias === normalizedCandidate) {
		return 120;
	}

	let score = tokenDiceCoefficient(normalizedAlias, normalizedCandidate) * 100;
	if (
		normalizedCandidate.includes(normalizedAlias) ||
		normalizedAlias.includes(normalizedCandidate)
	) {
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

function scoreEpisodeCountMatch(
	media: ScrapeCtx["media"],
	candidateEpisodeCount?: number,
): number {
	const targetEpisodeCount =
		media.type === "movie" ? 1 : media.season.episodeCount;
	if (!targetEpisodeCount || !candidateEpisodeCount) {
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

function scoreAnilistCandidate(
	media: ScrapeCtx["media"],
	aliases: string[],
	candidate: AnilistSearchMedia,
): number {
	const titlePool = [
		candidate.title.romaji,
		candidate.title.english,
		candidate.title.native,
		...(candidate.synonyms ?? []),
	]
		.filter((title): title is string => !!title)
		.slice(0, 20);

	let bestTitleScore = 0;
	for (const alias of aliases) {
		for (const candidateTitle of titlePool) {
			const score = scoreTitleMatch(alias, candidateTitle);
			if (score > bestTitleScore) {
				bestTitleScore = score;
			}
		}
	}

	let score = bestTitleScore;
	score += scoreYearMatch(media.releaseYear, candidate.seasonYear);
	score += scoreEpisodeCountMatch(media, candidate.episodes);
	score += matchesMediaType(media, candidate) ? 25 : -25;

	if (media.type === "movie" && candidate.format === "MOVIE") {
		score += 10;
	}

	return score;
}

async function searchAnilistCandidates(
	ctx: ScrapeCtx,
	query: string,
): Promise<AnilistSearchMedia[]> {
	const response = await ctx.fetcher<AnilistSearchResponse>("", {
		baseUrl: "https://graphql.anilist.co",
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			query: ANILIST_SEARCH_QUERY,
			variables: {
				search: query,
				type: "ANIME",
			},
		}),
	});

	return response.data?.Page?.media ?? [];
}

async function resolveAnilistIdWithFuzzyMatching(
	ctx: ScrapeCtx,
): Promise<number> {
	const aliases = buildTitleAliases(ctx.media.title);
	if (!aliases.length) {
		return getAnilistIdFromMedia(ctx, ctx.media);
	}

	const byId = new Map<number, AnilistSearchMedia>();
	for (const alias of aliases) {
		const items = await searchAnilistCandidates(ctx, alias);
		for (const item of items) {
			if (item?.id) {
				byId.set(item.id, item);
			}
		}
	}

	const scored = [...byId.values()]
		.map((candidate) => ({
			candidate,
			score: scoreAnilistCandidate(ctx.media, aliases, candidate),
		}))
		.sort((a, b) => b.score - a.score);

	if (scored[0] && scored[0].score >= MIN_ANILIST_CONFIDENCE_SCORE) {
		return scored[0].candidate.id;
	}

	return getAnilistIdFromMedia(ctx, ctx.media);
}

function parseQualityLabel(quality: string): Qualities {
	const match = quality.match(/(360|480|720|1080|2160)p/i);
	if (!match) return "unknown";

	const value = match[1];
	if (value === "2160") return "4k";
	if (value === "360" || value === "480" || value === "720" || value === "1080")
		return value;
	return "unknown";
}

function qualityPriority(quality: Qualities): number {
	if (quality === "4k") return 2160;
	if (quality === "1080") return 1080;
	if (quality === "720") return 720;
	if (quality === "480") return 480;
	if (quality === "360") return 360;
	return 0;
}

function getDeclaredCodecsFromManifest(manifest: string): string[] {
	const codecs: string[] = [];
	const codecMatches = manifest.matchAll(/codecs\s*=\s*"([^"]+)"/gi);

	for (const match of codecMatches) {
		const value = match[1] ?? "";
		for (const part of value.split(",")) {
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
		throw new NotFoundError(
			"1Anime stream payload is too short for Twofish CTR",
		);
	}

	const counter = input.slice(0, 16);
	const encrypted = input.slice(16);
	const out = new Uint8Array(encrypted.length);

	for (let offset = 0; offset < encrypted.length; offset += 16) {
		const keystream = new Uint8Array(16);
		encrypt(counter, 0, keystream, 0, TWOFISH_SESSION);
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
		result =
			i % 2 === 0 ? rotateRight(result, shift) : rotateLeft(result, shift);
		result = xorWithKey(result, XOR_KEYS[i]);
	}

	return result;
}

function decryptXChaCha(input: Uint8Array): Uint8Array {
	if (input.length <= 24) {
		throw new NotFoundError(
			"1Anime stream payload is too short for XChaCha20-Poly1305",
		);
	}

	const nonce = input.slice(0, 24);
	const ciphertextWithTag = input.slice(24);
	const xchacha = new XChaCha20Poly1305(XCHACHA_KEY);
	const opened = xchacha.open(nonce, ciphertextWithTag);

	if (!opened) {
		throw new NotFoundError("1Anime stream payload authentication failed");
	}

	return opened;
}

function decodeStreamBlob(result: string): DecryptedStreamPayload {
	const afterFirstBase64 = base64ToUtf8(result);
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
	options?: { method?: "GET" | "POST"; body?: string; timeoutMs?: number },
): Promise<T> {
	const response = await ctx.proxiedFetcher<T | string>(url, {
		method: options?.method,
		body: options?.body,
		timeoutMs: options?.timeoutMs,
		headers: options?.body
			? {
					"Content-Type": "application/json",
					Accept: "application/json",
				}
			: undefined,
	});

	if (typeof response === "string") {
		const trimmed = response.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			return JSON.parse(trimmed) as T;
		}
		throw new NotFoundError("1Anime API returned an unexpected response body");
	}

	if (!response || typeof response !== "object") {
		throw new NotFoundError("1Anime API returned an empty response");
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
			method: "GET",
			headers,
		});

		const manifest =
			typeof manifestResponse.body === "string"
				? manifestResponse.body
				: String(manifestResponse.body ?? "");

		if (!manifest) return true;

		const declaredCodecs = getDeclaredCodecsFromManifest(manifest);
		if (declaredCodecs.length === 0) return true;

		return !declaredCodecs.some((codec) =>
			UNSUPPORTED_HLS_AUDIO_CODECS.some((unsupported) =>
				codec.includes(unsupported),
			),
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
		subOrDub: "s" | "d";
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
	} catch (e) {
		console.error(
			`Error decoding 1Anime stream payload for provider ${args.providerName}:`,
			e,
		);
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
	const enabledModes: Array<"s" | "d"> = [...SUB_OR_DUB_ORDER];

	for (const providerName of PROVIDERS_IN_ORDER) {
		const streamsByLanguage: FoundProviderStreams["streamsByLanguage"] = {};

		for (const subOrDub of enabledModes) {
			const payload = await tryProviderMode(ctx, {
				anilistId: args.anilistId,
				providerName,
				episodeNumber: args.episodeNumber,
				subOrDub,
			});

			if (!payload) continue;
			const language = subOrDub === "d" ? "eng" : "jpn";
			streamsByLanguage[language] = payload;
		}

		if (streamsByLanguage.jpn || streamsByLanguage.eng) {
			return { providerName, streamsByLanguage };
		}
	}

	throw new NotFoundError("No playable 1Anime streams found across providers");
}

async function scrape1anime(ctx: ScrapeCtx): Promise<SourcererOutput> {
	ctx.progress(15);
	const anilistId = await resolveAnilistIdWithFuzzyMatching(ctx);

	ctx.progress(35);
	const episodeNumber =
		ctx.media.type === "movie" ? 1 : ctx.media.episode.number;

	ctx.progress(60);
	const found = await findWorkingProvider(ctx, {
		anilistId,
		episodeNumber,
	});

	const hlsStreams: NonNullable<SourcererOutput["stream"]> = [];
	const fileStreams: NonNullable<SourcererOutput["stream"]> = [];

	for (const [language, payload] of Object.entries(
		found.streamsByLanguage,
	) as Array<[LanguageBucket, DecryptedStreamPayload]>) {
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

			const quality = parseQualityLabel(source.quality ?? "");
			if (source.isM3U8) {
				hlsByLanguage.push({ quality, url: source.url });
			} else if (!fileByQuality[quality]) {
				fileByQuality[quality] = {
					type: "mp4",
					url: source.url,
				};
			}
		}

		const bestHls = hlsByLanguage.sort(
			(a, b) => qualityPriority(b.quality) - qualityPriority(a.quality),
		)[0];
		if (bestHls) {
			const streamHeaders: Record<string, string> = {};
			if (referer) streamHeaders.Referer = referer;
			if (origin) streamHeaders.Origin = origin;

			const supported = await isSupportedHlsPlaylist(
				ctx,
				bestHls.url,
				streamHeaders,
			);
			if (supported) {
				hlsStreams.push({
					id: language === "eng" ? "eng-audio" : "jpn-audio",
					type: "hls",
					playlist: createM3U8ProxyUrl(
						bestHls.url,
						ctx.features,
						streamHeaders,
					),
					headers: Object.keys(streamHeaders).length
						? streamHeaders
						: undefined,
					proxyDepth: 2,
					captions: [],
					flags: [flags.CORS_ALLOWED],
				});
			}
		}

		if (Object.keys(fileByQuality).length > 0) {
			fileStreams.push({
				id: language === "eng" ? "eng-audio-file" : "jpn-audio-file",
				type: "file",
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

	throw new NotFoundError(
		`No stream files were produced by 1Anime provider ${found.providerName}`,
	);
}

export const oneanimeScraper = makeSourcerer({
	id: "1anime",
	name: "1Anime 🔥",
	rank: 202,
	disabled: false,
	flags: [flags.CORS_ALLOWED],
	scrapeShow: scrape1anime,
	scrapeMovie: scrape1anime,
});
