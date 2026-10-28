import { existsSync, readFileSync } from "fs";
import path from "path";
import { app, fullUrlForClient } from "../server";
import { ElementInfo } from "../utils/element";
import { isNndId } from "../utils/niconico";
import { Router } from "express";

const router = Router();
export let elementsDir = "./dist/elements";

/**
 * Detect browser target from user agent
 * Returns the appropriate bundle directory for the client
 */
function getBundleTarget(userAgent: string): 'webview2' | 'ie11' | 'default' {
	// Check for IE11
	if (userAgent.includes('Trident') && userAgent.includes('MSIE') || userAgent.includes('rv:')) {
		return 'ie11';
	}
	
	// Check for Edge WebView2 (Chromium-based Edge)
	// WebView2 typically uses Edg/XX.X format
	if (userAgent.includes('Edg/') && !userAgent.includes('Chrome')) {
		return 'webview2';
	}
	
	// Check for chrome (WebView2 uses Chromium engine)
	if (userAgent.includes('Chrome')) {
		// Heuristic: if it's a WebView (not a full browser) and running on Windows
		// WebView2 typically has reduced user agent info
		if (userAgent.includes('Windows')) {
			return 'webview2';
		}
	}
	
	// Default to ie11 for legacy compatibility, but serve both bundles
	return 'default';
}

/**
 * Bare DASH player test endpoint. Redirects to the standalone dashplayer.html
 * page (served from dist/templates), preserving any ?url=<mpd> param. Handy for
 * smoke-testing manifests in a modern browser (localhost) and IE11 (10.0.2.2):
 *   /dash?url=https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_640x360_800k.mpd
 *   /dash?url=http://<host>:3000/sabr/<videoId>/master.mpd
 */
router.get("/dash", async (req, res) => {
	const userAgent = req.headers['user-agent'] || '';
	const bundleTarget = getBundleTarget(userAgent);
	console.log(`[Templates] Bare dash player, target: ${bundleTarget}`);

	const url = req.query.url
		? `?url=${encodeURIComponent(String(req.query.url))}`
		: '';
	res.redirect(`/templates/dashplayer.html${url}`);
});

router.get("/templateUrl/:id", async (req, res) => {	const id = req.params.id;
	const userAgent = req.headers['user-agent'] || '';
	const bundleTarget = getBundleTarget(userAgent);
	
	// Niconico Douga ids (sm|nm|so|ca + digits, or legacy numeric) are not
	// 11 chars, so they must be accepted before the YouTube length check or
	// they fall through to the elements-dir lookup and 404 into SM's
	// youtube.supermemo.org fallback.
	if (isNndId(id) || id.length == 11) {
		console.log(`[Templates] Player request for video ID: ${id}`);
		console.log(`[Templates] Browser detected: ${bundleTarget}, User-Agent: ${userAgent}`);
		
		// Return templates URL without adding query params
		// SuperMemo will append its own: videoid, resume, start, stop, ts
		// We pass target through the HTML template's detection logic instead
		res.send(`http://${fullUrlForClient}/templates/smplayer.html`);
		return;
	}

	// open FS at elements/id and read info.json, return its HTML
	// patch together and send
	const dir = path.join(elementsDir, id);
	if (!existsSync(dir)) {
		res.status(404).send("Not found: " + dir);
		return;
	}
	const info = JSON.parse(
		readFileSync(path.join(dir, "info.json"), "utf-8")
	) as ElementInfo;

	// open at templates/id.html and ret the template
	// const template = JSON.parse(readFileSync(path.join(archiveDir, 'templates', info.templateId + '.json'), 'utf-8'));
	res.send(`http://${fullUrlForClient}/templates/${info.templateId}.html`);
});

export default router;
