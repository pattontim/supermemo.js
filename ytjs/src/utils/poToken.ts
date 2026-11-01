/*
 * Local DOM PO token provider — a port of PipePipe's LocalDomPoTokenProvider.kt
 * + PersistentMintSession, running the BotGuard VM inside a shared Camoufox
 * browser instead of JSDOM.
 *
 * Replaces the previous JSDOM + @napi-rs/canvas implementation in its entirety.
 * The ~900 lines of global shims (fake navigator/plugins/performance, canvas
 * delegation, toString spoofing, Error.stack sanitizing, …) existed only to
 * approximate a browser; Camoufox *is* a browser, so they are gone.
 *
 * Flow (identical to PipePipe's):
 *   GET https://www.youtube.com
 *     -> parseYoutubePageAttestationBootstrap (binding, visitor, eventId, challenge)
 *     -> inject sabrPoTokenScript into the sandbox's main world
 *     -> pipepipeSabrRunBotguard(sessionId, eventId, challenge-with-interpreter)
 *     -> GenerateIT  (Node-side POST, outside the browser)
 *     -> pipepipeSabrCreateMinter(sessionId, integrityToken)
 *     -> [SESSION] mint once against DATASYNC_ID / VISITOR_DATA
 *        [CONTENT] mint per videoId
 */

import { getHeaders } from "bgutils-js/utils";

import {
	parseYoutubePageAttestationBootstrap,
	parseSabrAttChallengeData,
	SabrProtocolError,
	type SabrAttChallengeData,
	type YoutubePageAttestationBootstrap,
	type YoutubePoTokenBinding,
} from "./ytBootstrap";
import { SharedCamoufoxRuntime } from "./camoufoxRuntime";
import { SABR_PO_TOKEN_SCRIPT } from "./sabrPoTokenScript";
import { censusLog, logChallenge } from "./bgCensus";

const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const TOKEN_TIMEOUT_MS = Number(process.env.YTJS_POTOKEN_TIMEOUT_MS ?? 60_000);
const EXPIRY_MARGIN_MS = 60_000;
const YOUTUBE_HOME = "https://www.youtube.com";
/** PipePipe sends the same anonymous cookie when no account cookies exist. */
const ANONYMOUS_COOKIE = "PREF=hl=en&gl=US";

export interface PoTokenMintResult {
	/** Websafe-base64 (no padding), exactly as PipePipe's getPlayerPoToken. */
	poToken: string;
	visitorData: string;
	clientVersion: string;
}

/**
 * GenerateIT is posted from Node, not from the browser — in PipePipe it goes
 * through DownloaderImpl, i.e. outside the WebView. The endpoint/headers match
 * bgutils-js's `buildURL("GenerateIT", true)` + `getHeaders()`, which resolve to
 * the same jnn-pa Waa call PipePipe makes.
 */
async function generateIntegrityToken(
	botguardResponse: string,
	userAgent: string,
): Promise<{ integrityToken: string; ttlSeconds: number }> {
	// Posted from Node, inspired by PipePipe's DownloaderImpl (outside the
	// WebView). This endpoint returns ~172 bytes of headers, so undici's cap is
	// not a concern here - and keeping it out of the browser avoids sending the
	// profile's cookies/Origin, which makes YouTube reject the BotGuard
	// response and answer [null, ttl, null, fallback] instead of a token.
	const response = await fetch("https://www.youtube.com/api/jnn/v1/GenerateIT", {
		method: "POST",
		// getHeaders() already sets content-type: application/json+protobuf.
		// Do NOT override it - the endpoint rejects application/json with 400.
		headers: {
			...getHeaders(),
			"user-agent": userAgent,
		},
		body: JSON.stringify([REQUEST_KEY, botguardResponse]),
	});

	if (!response.ok) {
		throw new SabrProtocolError(`Local DOM BotGuard request failed: ${response.status}`);
	}

	const raw = await response.text();
	let body: any;
	try {
		body = JSON.parse(raw);
	} catch {
		throw new SabrProtocolError(
			`GenerateIT returned non-JSON (${response.status}): ${raw.slice(0, 300)}`,
		);
	}
	if (typeof body?.[0] !== "string") {
		throw new SabrProtocolError(
			`Could not get integrity token: ${JSON.stringify(body).slice(0, 300)}`,
		);
	}
	const ttlSeconds = typeof body[1] === "number" ? body[1] : 43_200;
	return { integrityToken: uint8Literal(base64ToBytes(body[0])), ttlSeconds };
}

/** Base64 (any alphabet) -> bytes, tolerating url-safe chars and padding. */
export function base64ToBytes(value: string): Uint8Array {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\./g, "=");
	const binary = Buffer.from(normalized, "base64");
	return new Uint8Array(binary.buffer, binary.byteOffset, binary.byteLength);
}

function uint8Literal(bytes: Uint8Array): string {
	return `new Uint8Array([${Array.from(bytes).join(",")}])`;
}

function stringToU8Literal(value: string): string {
	return uint8Literal(new TextEncoder().encode(value));
}

function jsonString(value: string): string {
	return JSON.stringify(value);
}

/**
 * GET a URL from Node, falling back to the browser when undici rejects the
 * response.
 *
 * Node is preferred because it is cookieless and cheap. YouTube's homepage
 * normally returns ~11KB of headers, but some responses (CSP report-only +
 * allowlist headers, or a bloated Set-Cookie chain) exceed undici's hard 16KB
 * cap and fail with UND_ERR_HEADERS_OVERFLOW. Only then do we pay for a
 * browser round-trip, which has no such cap.
 */
async function fetchText(
	url: string,
	headers: Record<string, string>,
	label: string,
): Promise<string> {
	try {
		const response = await fetch(url, { headers });
		if (!response.ok) {
			throw new SabrProtocolError(`${label} failed: ${response.status}`);
		}
		return await response.text();
	} catch (error) {
		const code = (error as { cause?: { code?: string } }).cause?.code;
		if (code !== "UND_ERR_HEADERS_OVERFLOW") throw error;
		console.warn(`[potoken] ${label}: Node header overflow, retrying via browser`);
		const runtime = SharedCamoufoxRuntime.get();
		const response = await runtime.fetchViaBrowser(url, { headers });
		if (!response.ok) {
			throw new SabrProtocolError(`${label} failed: ${response.status}`);
		}
		return await response.text();
	}
}

async function fetchHomeBootstrap(): Promise<YoutubePageAttestationBootstrap> {
	const runtime = SharedCamoufoxRuntime.get();
	// Make sure the UA is known before the fetch (PipePipe sends
	// SharedWebViewRuntime.USER_AGENT on this request for the same reason).
	await runtime.ensureReady();

	// Retry a couple of times: the oversized-header response is intermittent.
	let lastError: unknown;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const html = await fetchText(
				YOUTUBE_HOME,
				{
					"Accept-Language": "en-US",
					"Cookie": ANONYMOUS_COOKIE,
					"User-Agent": runtime.getUserAgent(),
				},
				"YouTube home initialization",
			);
			return parseYoutubePageAttestationBootstrap(html);
		} catch (error) {
			lastError = error;
			console.error(`[potoken] home bootstrap attempt ${attempt} failed`, error);
		}
	}
	throw lastError;
}

/** Fetch the interpreter script when the challenge carries only a URL. */
async function fetchInterpreter(challenge: SabrAttChallengeData): Promise<string> {
	if (challenge.interpreterJavascript) return challenge.interpreterJavascript;
	if (!challenge.interpreterUrl) {
		throw new SabrProtocolError("Attestation challenge has no interpreter script or URL");
	}
	const runtime = SharedCamoufoxRuntime.get();
	return await fetchText(
		challenge.interpreterUrl,
		{ "User-Agent": runtime.getUserAgent(), Accept: "*/*" },
		"Local DOM BotGuard GET",
	);
}

/**
 * A single PO token minter bound to one bootstrap (visitor identity + challenge
 * + integrity token), mirroring PersistentMintSession.
 */
export class PersistentMintSession {
	private closed = false;
	private expiresAtMs = Number.MAX_SAFE_INTEGER;
	/** Minted once for SESSION binding (PipePipe's sessionPoToken). */
	private sessionToken?: Uint8Array;

	private constructor(
		private readonly sessionId: string,
		public readonly bootstrap: YoutubePageAttestationBootstrap,
	) {}

	static async create(): Promise<PersistentMintSession> {
		const bootstrap = await fetchHomeBootstrap();
		if (bootstrap.binding === "NONE") {
			throw new SabrProtocolError(
				"YouTube home does not enable a supported PO token binding",
			);
		}

		const session = new PersistentMintSession(
			`sabr-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			bootstrap,
		);
		try {
			await session.initialize();
			return session;
		} catch (error) {
			await session.close();
			throw error;
		}
	}

	/** The identifier a SESSION-bound token is minted against. */
	private sessionBinding(): string {
		if (this.bootstrap.dataSyncId) return this.bootstrap.dataSyncId;
		// No account cookies are configured for this single-user server, so the
		// anonymous visitor identity is the session binding (PipePipe's
		// `loggedIn ? dataSyncId : visitorData`).
		return this.bootstrap.visitorData;
	}

	private async initialize(): Promise<void> {
		const runtime = SharedCamoufoxRuntime.get();
		await runtime.ensureReady();
		await runtime.injectIntoMainWorld(SABR_PO_TOKEN_SCRIPT);

		const challenge = this.bootstrap.challenge;
		const interpreterJavascript = await fetchInterpreter(challenge);
		const interpreterUrl =
			challenge.interpreterUrl ??
			`inline:${(challenge.interpreterJavascript ?? "").slice(0, 32)}`;

		logChallenge({
			videoId: "(homepage)",
			interpreterUrl,
			program: challenge.program,
			globalName: challenge.globalName,
			interpreterJavascript,
			ytConfig: this.bootstrap.ytConfig,
			context: this.bootstrap.ytConfig?.INNERTUBE_CONTEXT,
		});

		const challengeData = {
			interpreterJavascript: {
				privateDoNotAccessOrElseSafeScriptWrappedValue: interpreterJavascript,
			},
			program: challenge.program,
			globalName: challenge.globalName,
		};

		const botguardResponse = await withTimeout(
			runtime.evaluateInMainWorld<string>(
				`window.pipepipeSabrRunBotguard(${jsonString(this.sessionId)}, ` +
					`${jsonString(this.bootstrap.eventId)}, ${JSON.stringify(challengeData)})`,
			),
			TOKEN_TIMEOUT_MS,
			"Local DOM BotGuard execution",
		);
		if (typeof botguardResponse !== "string" || !botguardResponse) {
			throw new SabrProtocolError("Local DOM BotGuard execution returned no response");
		}
		if (process.env.YTJS_POTOKEN_DEBUG === "1") {
			console.log(
				`[potoken] botguardResponse len=${botguardResponse.length} ` +
					`head=${botguardResponse.slice(0, 80)} eventId=${this.bootstrap.eventId} ` +
					`globalName=${challenge.globalName} programLen=${challenge.program?.length ?? 0} ` +
					`interpLen=${interpreterJavascript.length}`,
			);
		}

		const { integrityToken, ttlSeconds } = await generateIntegrityToken(
			botguardResponse,
			runtime.getUserAgent(),
		);
		this.expiresAtMs = Date.now() + ttlSeconds * 1000;

		await runtime.evaluateInMainWorld(
			`window.pipepipeSabrCreateMinter(${jsonString(this.sessionId)}, ${integrityToken})`,
		);

		censusLog({
			poTokenSession: {
				binding: this.bootstrap.binding,
				visitorData: this.bootstrap.visitorData,
				hasDataSyncId: !!this.bootstrap.dataSyncId,
				clientName: this.bootstrap.clientName,
				clientVersion: this.bootstrap.clientVersion,
				ttlSeconds,
			},
		});

		if (this.bootstrap.binding === "SESSION") {
			// Mint once and reuse for every video (PipePipe's sessionPoToken).
			this.sessionToken = await this.mintRaw(this.sessionBinding());
		}
	}

	/** Mint a PO token for a video (CONTENT binding) or the session (SESSION). */
	async mint(videoId: string): Promise<Uint8Array> {
		if (this.closed) throw new SabrProtocolError("Local DOM PO token session is closed");
		if (this.bootstrap.binding === "SESSION") {
			if (!this.sessionToken) {
				throw new SabrProtocolError("Local DOM session PO token is missing");
			}
			return new Uint8Array(this.sessionToken);
		}
		return this.mintRaw(videoId);
	}

	private async mintRaw(identifier: string): Promise<Uint8Array> {
		const runtime = SharedCamoufoxRuntime.get();
		const result = await withTimeout(
			runtime.evaluateInMainWorld<number[]>(
				`window.pipepipeSabrObtainPoToken(${jsonString(this.sessionId)}, ` +
					`${stringToU8Literal(identifier)})`,
			),
			TOKEN_TIMEOUT_MS,
			"Local DOM PO token generation",
		);
		if (!Array.isArray(result) || result.length === 0) {
			throw new SabrProtocolError("Local DOM PO token generation returned no token");
		}
		return Uint8Array.from(result);
	}

	isExpired(): boolean {
		return this.closed || Date.now() >= this.expiresAtMs - EXPIRY_MARGIN_MS;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			await SharedCamoufoxRuntime.get().evaluateInMainWorld(
				`window.pipepipeSabrDeleteSession(${jsonString(this.sessionId)})`,
			);
		} catch {
			/* sandbox already gone */
		}
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_resolve, reject) =>
			setTimeout(() => reject(new SabrProtocolError(`${label} timed out`)), ms),
		),
	]);
}

/*
 * Provider-level state (single-user server): one warm minter, re-warmed after
 * invalidation. Mirrors LocalDomPoTokenProvider's initializationTask/warmUp.
 */
let mintTask: Promise<PersistentMintSession> | undefined;
let sessionTokenCache: Uint8Array | undefined;

/** Pre-launch the browser and build the minter; safe to call repeatedly. */
export function warmUpPoTokenMinter(): void {
	if (!mintTask) {
		mintTask = PersistentMintSession.create().catch((error) => {
			mintTask = undefined;
			console.error("[potoken] minter initialization failed", error);
			throw error;
		});
		// Avoid an unhandled rejection if nobody is awaiting yet.
		mintTask.catch(() => {});
	}
}

/**
 * Drop the rejected minter and immediately re-warm, as PipePipe's invalidate().
 * Passing the rejected token makes a stale invalidation a no-op.
 */
export function invalidate(rejectedToken?: Uint8Array): void {
	if (rejectedToken && sessionTokenCache && !bytesEqual(sessionTokenCache, rejectedToken)) {
		return;
	}
	sessionTokenCache = undefined;
	const task = mintTask;
	mintTask = undefined;
	if (task) {
		void task.then((session) => session.close()).catch(() => {});
	}
	console.log("[potoken] invalidated rejected PO token minter");
	warmUpPoTokenMinter();
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

async function getState(): Promise<PersistentMintSession> {
	for (;;) {
		warmUpPoTokenMinter();
		const task = mintTask!;
		const session = await task;
		if (!session.isExpired()) return session;
		if (mintTask === task) {
			mintTask = undefined;
			await session.close();
		}
	}
}

/**
 * The visitor identity the cached minter is bound to (for callers that need to
 * declare the same visitor in a SABR StreamerContext). Does not mint.
 */
export async function getMintedVisitor(): Promise<string | undefined> {
	try {
		const session = await getState();
		return session.bootstrap.visitorData;
	} catch {
		return undefined;
	}
}

/**
 * Get a PO token for `videoId`. Content-bound tokens are minted per call.
 * Session-bound tokens are minted once and reused (see PersistentMintSession).
 */
export async function getPlayerPoToken(videoId: string): Promise<PoTokenMintResult> {
	const session = await getState();
	const binding: YoutubePoTokenBinding = session.bootstrap.binding;

	let token: Uint8Array;
	if (binding === "SESSION") {
		if (!sessionTokenCache) {
			sessionTokenCache = await session.mint(videoId);
		}
		token = sessionTokenCache;
	} else {
		token = await session.mint(videoId);
	}

	return {
		poToken: Buffer.from(token).toString("base64url"),
		visitorData: session.bootstrap.visitorData,
		clientVersion: session.bootstrap.clientVersion,
	};
}

export { parseSabrAttChallengeData };
