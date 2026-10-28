/*
 * Minimal HLS playlist helpers for the NND domand path.
 *
 * Only what smjs needs:
 *   - detect/parse a master playlist's variants
 *   - rewrite every URI in a playlist so variants, audio renditions,
 *     segments, the EXT-X-MAP init segment and the EXT-X-KEY AES-128 key
 *     all come back through the local /nnd/proxy/ route (domand hosts send
 *     no CORS headers, and IE11 cannot fetch them cross-origin).
 *
 * Segment decryption stays client-side: hls.js reads EXT-X-KEY itself, we
 * only move the key URI.
 *
 * IMPORTANT: the domand master playlist carries audio as a separate
 * EXT-X-MEDIA rendition, so the master must be served as a master. Flattening
 * it to the video variant would silently drop audio.
 */

export interface HlsVariant {
	uri: string;
	bandwidth?: number;
	resolution?: string;
	attrs: string;
}

export function isMasterPlaylist(text: string): boolean {
	return text.indexOf("#EXT-X-STREAM-INF") !== -1 || text.indexOf("#EXT-X-MEDIA:") !== -1;
}

export function parseMasterPlaylist(text: string, baseUrl: string): HlsVariant[] {
	const lines = text.split(/\r?\n/);
	const variants: HlsVariant[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line.indexOf("#EXT-X-STREAM-INF:") !== 0) continue;
		const attrs = line.slice("#EXT-X-STREAM-INF:".length);
		// The URI is on the next non-empty line.
		let uriLine = "";
		for (let j = i + 1; j < lines.length; j++) {
			const candidate = lines[j].trim();
			if (candidate && candidate.indexOf("#") !== 0) {
				uriLine = candidate;
				break;
			}
		}
		if (!uriLine) continue;

		let uri: string;
		try {
			uri = new URL(uriLine, baseUrl).href;
		} catch (e) {
			uri = uriLine;
		}

		const bw = /BANDWIDTH=(\d+)/.exec(attrs);
		const res = /RESOLUTION=([0-9]+x[0-9]+)/.exec(attrs);
		variants.push({
			uri,
			bandwidth: bw ? Number(bw[1]) : undefined,
			resolution: res ? res[1] : undefined,
			attrs,
		});
	}
	return variants;
}

function proxify(uri: string, proxyBase: string, id?: string): string {
	const sep = proxyBase.indexOf("?") === -1 ? "?" : "&";
	const idPart = id ? `id=${encodeURIComponent(id)}&` : "";
	return `${proxyBase}${sep}${idPart}url=${encodeURIComponent(uri)}`;
}

/** Resolves a playlist URI against the playlist's own URL when relative. */
function absolutize(uri: string, baseUrl?: string): string {
	if (uri.indexOf("://") !== -1) return uri;
	if (uri.charAt(0) === "/" || !baseUrl) return uri;
	try {
		return new URL(uri, baseUrl).href;
	} catch (e) {
		return uri;
	}
}

/**
 * Rewrites every fetchable URI in a playlist (master or media) to go through
 * the local proxy. Tags carrying URI="..." (EXT-X-MEDIA, EXT-X-MAP,
 * EXT-X-KEY, EXT-X-I-FRAME-STREAM-INF) and bare URI lines are handled.
 */
export function rewritePlaylist(
	text: string,
	proxyBase: string,
	id?: string,
	baseUrl?: string
): string {
	const lines = text.split(/\r?\n/);
	const out: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (!trimmed) {
			out.push(line);
			continue;
		}

		if (trimmed.charAt(0) === "#") {
			if (trimmed.indexOf('URI="') === -1) {
				out.push(line);
				continue;
			}
			out.push(
				trimmed.replace(/URI="([^"]+)"/g, function (_m, u: string) {
					const abs = absolutize(u, baseUrl);
					if (abs.indexOf("://") === -1) return 'URI="' + u + '"';
					return 'URI="' + proxify(abs, proxyBase, id) + '"';
				})
			);
			continue;
		}

		// Bare URI line: variant playlist, audio rendition or media segment.
		const abs = absolutize(trimmed, baseUrl);
		out.push(abs.indexOf("://") === -1 ? line : proxify(abs, proxyBase, id));
	}

	return out.join("\n");
}
