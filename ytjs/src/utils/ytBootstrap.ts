/*
 * Port of PipePipe's YoutubePageAttestationBootstrap.kt.
 *
 * Parses the YouTube *homepage* for everything the Local DOM PO token provider
 * needs: the WEB Innertube client context, the visitor/data-sync identifiers,
 * the EVENT_ID, which PO token binding YouTube currently wants (CONTENT or
 * SESSION, read from the watch client's serialized experiment flags), and the
 * initial BotGuard attestation challenge.
 *
 * The extraction is deliberately not regex-only: `ytcfg.set({...})` and
 * `window.ytAtN({...})` carry nested objects and JS string literals with
 * escapes, so a brace matcher plus a JS string decoder are required.
 */

export type YoutubePoTokenBinding = "CONTENT" | "SESSION" | "NONE";

export interface SabrAttChallengeData {
	program: string;
	globalName: string;
	interpreterJavascript?: string;
	interpreterUrl?: string;
}

export interface YoutubePageAttestationBootstrap {
	visitorData: string;
	dataSyncId?: string;
	clientName: string;
	clientVersion: string;
	binding: YoutubePoTokenBinding;
	eventId: string;
	challenge: SabrAttChallengeData;
	/** The full ytcfg object the challenge call was preceded by (for window.yt.config_). */
	ytConfig: any;
}

const YTCFG_CALLEE = "ytcfg.set";
/** Both the historical and current challenge callee names appear in the wild. */
const INITIAL_ATTESTATION_CALLEES = ["window.ytAtN", "window.ytAtR"];

const INITIAL_ATTESTATION_RESPONSE = /['"]R['"]\s*:\s*(['"])/;

export class SabrProtocolError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message);
		this.name = "SabrProtocolError";
		if (cause !== undefined) (this as any).cause = cause;
	}
}

interface JavascriptObjectCall {
	start: number;
	argument: string;
}

/** Balanced-brace scan for the object argument of every `callee ({...})` call. */
function extractObjectCallArguments(source: string, callee: string): JavascriptObjectCall[] {
	const found: JavascriptObjectCall[] = [];
	let searchFrom = 0;
	for (;;) {
		const callStart = source.indexOf(callee, searchFrom);
		if (callStart < 0) return found;
		let openingParenthesis = callStart + callee.length;
		while (openingParenthesis < source.length && /\s/.test(source[openingParenthesis])) {
			openingParenthesis++;
		}
		if (source[openingParenthesis] !== "(") {
			searchFrom = callStart + callee.length;
			continue;
		}
		let objectStart = openingParenthesis + 1;
		while (objectStart < source.length && /\s/.test(source[objectStart])) objectStart++;
		if (source[objectStart] !== "{") {
			searchFrom = openingParenthesis + 1;
			continue;
		}
		const objectEnd = findJavascriptObjectEnd(source, objectStart);
		if (objectEnd < 0) {
			searchFrom = objectStart + 1;
			continue;
		}
		found.push({ start: callStart, argument: source.slice(objectStart, objectEnd + 1) });
		searchFrom = objectEnd + 1;
	}
}

function findJavascriptObjectEnd(source: string, start: number): number {
	let depth = 0;
	let quote = "\u0000";
	let escaped = false;
	for (let index = start; index < source.length; index++) {
		const character = source[index];
		if (quote !== "\u0000") {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = "\u0000";
			continue;
		}
		if (character === "'" || character === '"') quote = character;
		else if (character === "{") depth++;
		else if (character === "}") {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}

/** Decode a JS string literal body starting just after its opening quote. */
function decodeJavascriptString(source: string, start: number, quote: string): string {
	let result = "";
	let index = start;
	while (index < source.length) {
		const character = source[index++];
		if (character === quote) return result;
		if (character !== "\\") {
			result += character;
			continue;
		}
		if (index >= source.length) throw new Error("Incomplete JavaScript string escape");
		const escaped = source[index++];
		switch (escaped) {
			case "b": result += "\b"; break;
			case "f": result += "\f"; break;
			case "n": result += "\n"; break;
			case "r": result += "\r"; break;
			case "t": result += "\t"; break;
			case "v": result += "\v"; break;
			case "x":
				result += String.fromCharCode(readJavascriptHex(source, index, 2));
				index += 2;
				break;
			case "u":
				result += String.fromCharCode(readJavascriptHex(source, index, 4));
				index += 4;
				break;
			case "\n": break;
			case "\r":
				if (source[index] === "\n") index++;
				break;
			default: result += escaped;
		}
	}
	throw new Error("Unterminated JavaScript string");
}

function readJavascriptHex(source: string, start: number, length: number): number {
	if (start + length > source.length) throw new Error("Incomplete hexadecimal escape");
	let value = 0;
	for (let offset = 0; offset < length; offset++) {
		const digit = parseInt(source[start + offset], 16);
		if (Number.isNaN(digit)) throw new Error("Invalid hexadecimal escape");
		value = value * 16 + digit;
	}
	return value;
}

/** `a=1&b&c=2` -> { a: "1", b: "true", c: "2" } (PipePipe's parseExperimentFlags). */
export function parseExperimentFlags(serializedFlags: string): Record<string, string> {
	const flags: Record<string, string> = {};
	for (const part of serializedFlags.split("&")) {
		const separator = part.indexOf("=");
		if (separator < 0) flags[part] = "true";
		else flags[part.slice(0, separator)] = part.slice(separator + 1);
	}
	return flags;
}

/** Parse an attestation response body's `bgChallenge` into challenge data. */
export function parseSabrAttChallengeData(rawAttestationData: string): SabrAttChallengeData {
	const parsed = JSON.parse(rawAttestationData);
	const challenge = parsed?.bgChallenge;
	if (!challenge) throw new SabrProtocolError("Attestation response has no BotGuard challenge");

	const interpreterJavascript =
		challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue || undefined;
	const rawInterpreterUrl =
		challenge.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue || undefined;
	const interpreterUrl = rawInterpreterUrl
		? rawInterpreterUrl.startsWith("//")
			? `https:${rawInterpreterUrl}`
			: rawInterpreterUrl
		: undefined;

	if (!interpreterJavascript && !interpreterUrl) {
		throw new SabrProtocolError("Attestation challenge has no interpreter script or URL");
	}
	const program = challenge.program || undefined;
	if (!program) throw new SabrProtocolError("Attestation challenge has no program");
	const globalName = challenge.globalName || undefined;
	if (!globalName) throw new SabrProtocolError("Attestation challenge has no global name");

	return { program, globalName, interpreterJavascript, interpreterUrl };
}

function parseInitialAttestationChallenge(argument: string): SabrAttChallengeData | null {
	const match = INITIAL_ATTESTATION_RESPONSE.exec(argument);
	if (!match) return null;
	const quote = match[1];
	let rawChallenge: string;
	try {
		rawChallenge = decodeJavascriptString(argument, match.index + match[0].length, quote);
	} catch {
		return null;
	}
	try {
		return parseSabrAttChallengeData(rawChallenge);
	} catch {
		return null;
	}
}

/**
 * Parse the YouTube homepage into the attestation bootstrap. Throws
 * SabrProtocolError with PipePipe's exact failure messages so log output maps
 * 1:1 to the Android implementation.
 */
export function parseYoutubePageAttestationBootstrap(
	pageHtml: string,
): YoutubePageAttestationBootstrap {
	const configCalls = extractObjectCallArguments(pageHtml, YTCFG_CALLEE)
		.map((call) => {
			try {
				return { ...call, parsed: JSON.parse(call.argument) };
			} catch {
				return null;
			}
		})
		.filter((call): call is JavascriptObjectCall & { parsed: any } => call !== null);

	let challengeCall: { start: number; challenge: SabrAttChallengeData } | undefined;
	for (const callee of INITIAL_ATTESTATION_CALLEES) {
		for (const call of extractObjectCallArguments(pageHtml, callee)) {
			const challenge = parseInitialAttestationChallenge(call.argument);
			if (challenge) {
				challengeCall = { start: call.start, challenge };
				break;
			}
		}
		if (challengeCall) break;
	}
	if (!challengeCall) {
		throw new SabrProtocolError("YouTube home has no initial attestation challenge");
	}

	// Only ytcfg calls that appear BEFORE the challenge call describe the state
	// the challenge was issued against.
	const configs = configCalls
		.filter((call) => call.start < challengeCall.start)
		.map((call) => call.parsed);

	const clientConfig = [...configs].reverse().find((config) => config?.INNERTUBE_CONTEXT);
	if (!clientConfig) throw new SabrProtocolError("YouTube home has no client context");

	const pickLast = (key: string): string | undefined => {
		for (let i = configs.length - 1; i >= 0; i--) {
			const value = configs[i]?.[key];
			if (typeof value === "string" && value.length > 0) return value;
		}
		return undefined;
	};

	const eventId = pickLast("EVENT_ID");
	if (!eventId) throw new SabrProtocolError("YouTube home has no EVENT_ID");

	const visitorData = (
		clientConfig.EOM_VISITOR_DATA ??
		clientConfig.VISITOR_DATA
	)?.replace(/%3D/gi, "=");
	if (!visitorData) throw new SabrProtocolError("YouTube home has no anonymous visitor data");

	const dataSyncId = pickLast("DATASYNC_ID");

	const client = clientConfig.INNERTUBE_CONTEXT?.client;
	if (!client) throw new SabrProtocolError("YouTube home has no Innertube client context");
	const clientName = client.clientName;
	if (!clientName) throw new SabrProtocolError("YouTube home has no client name");
	if (clientName !== "WEB") {
		throw new SabrProtocolError(`Unsupported YouTube home client: ${clientName}`);
	}
	const clientVersion = client.clientVersion;
	if (!clientVersion) throw new SabrProtocolError("YouTube home has no client version");

	const watchConfig =
		clientConfig.WEB_PLAYER_CONTEXT_CONFIGS?.WEB_PLAYER_CONTEXT_CONFIG_ID_KEVLAR_WATCH;
	const experimentFlags = watchConfig?.serializedExperimentFlags
		? parseExperimentFlags(watchConfig.serializedExperimentFlags)
		: {};

	const binding: YoutubePoTokenBinding =
		experimentFlags.html5_generate_content_po_token === "true"
			? "CONTENT"
			: experimentFlags.html5_generate_session_po_token === "true"
				? "SESSION"
				: watchConfig === undefined
					? "CONTENT"
					: "NONE";

	return {
		visitorData,
		dataSyncId,
		clientName,
		clientVersion,
		binding,
		eventId,
		challenge: challengeCall.challenge,
		ytConfig: clientConfig,
	};
}
