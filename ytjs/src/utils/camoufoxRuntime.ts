/*
 * Shared Camoufox runtime — the Node analogue of PipePipe's
 * SharedWebViewRuntime.
 *
 * One persistent, hidden browser context lives for the whole process and acts
 * as the JavaScript sandbox for every BotGuard mint. Two properties are
 * deliberately reproduced from PipePipe:
 *
 *   1. ONE persistent VM realm. The context is created once, so
 *      `window.__sabrLocalDomSessions` and any BotGuard-installed globals
 *      survive across mints. Creating a browser per mint would mint under a new
 *      fingerprint identity every time.
 *   2. ZERO network inside the sandbox. `page.route` serves the navigation
 *      itself and aborts everything else, exactly like
 *      `settings.setBlockNetworkLoads(true)`. All real HTTP (homepage scrape,
 *      interpreter fetch, GenerateIT) happens in Node, like PipePipe's
 *      DownloaderImpl.
 *
 * Every mint-related evaluation uses the `mw:` prefix, which camoufox
 * (main_world_eval: true) replays in the page's own world — the equivalent of
 * WebView's evaluateJavascript running in the main frame.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Camoufox } from "camoufox";
import type { BrowserContext, Page } from "playwright-core";

/** Kept in sync with the UA the browser actually reports (see README notes). */
const FALLBACK_UA =
	"Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0";

const PROFILE_DIR = resolve(
	process.env.YTJS_CAMOUFOX_PROFILE ?? ".cache/camoufox-profile",
);

const INIT_TIMEOUT_MS = Number(process.env.YTJS_CAMOUFOX_INIT_TIMEOUT_MS ?? 120_000);

/**
 * Minimal document served in place of the real homepage. It exists only to give
 * the sandbox a genuine `https://www.youtube.com/` origin so BotGuard sees a
 * plausible `location` — the same role PipePipe's `runtimeDocument` plays.
 */
const RUNTIME_DOCUMENT = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>YouTube</title></head><body></body></html>`;

type Headless = boolean | "virtual";

function parseHeadless(value: string | undefined): Headless {
	if (value === "virtual") return "virtual";
	if (value === "true" || value === "1") return true;
	return false;
}

export class SharedCamoufoxRuntime {
	private static instance: SharedCamoufoxRuntime | undefined;

	private context?: BrowserContext;
	private page?: Page;
	private userAgent: string = FALLBACK_UA;
	private startPromise?: Promise<void>;
	private closed = false;

	static get(): SharedCamoufoxRuntime {
		if (!SharedCamoufoxRuntime.instance) {
			SharedCamoufoxRuntime.instance = new SharedCamoufoxRuntime();
		}
		return SharedCamoufoxRuntime.instance;
	}

	/** The UA the sandbox reports; Node-side requests must match it. */
	getUserAgent(): string {
		return this.userAgent;
	}

	/** The persistent sandbox page, launching the browser on first use. */
	async getPage(): Promise<Page> {
		await this.ensureReady();
		return this.page!;
	}

	/**
	 * Launch the browser and navigate to the synthetic homepage document once.
	 * Concurrent callers share the same in-flight launch.
	 */
	async ensureReady(timeoutMs = INIT_TIMEOUT_MS): Promise<void> {
		if (this.closed) throw new Error("Shared Camoufox runtime is closed");
		if (this.page) return;
		if (!this.startPromise) {
			this.startPromise = this.launch().catch((error) => {
				this.startPromise = undefined;
				throw error;
			});
		}
		await this.withTimeout(this.startPromise, timeoutMs, "Camoufox launch");
	}

	/** Run an expression in the page's OWN world (`mw:`) and return its value. */
	async evaluateInMainWorld<T = unknown>(expression: string): Promise<T> {
		const page = await this.getPage();
		return (await page.evaluate(`mw:${expression}`)) as T;
	}

	/**
	 * Inject a script into the page's own world. Assignments made here persist on
	 * the sandbox window for the life of the context — this is how the BotGuard
	 * helper entry points get installed, mirroring
	 * `runtime.evaluateJavascriptBlocking(loadAsset(ASSET))`.
	 */
	async injectIntoMainWorld(source: string, timeoutMs = INIT_TIMEOUT_MS): Promise<void> {
		const page = await this.getPage();
		await this.withTimeout(
			page.evaluate(`mw:(() => { ${source}\n; return true; })()`),
			timeoutMs,
			"main-world script injection",
		);
	}

	async close(): Promise<void> {
		this.closed = true;
		this.startPromise = undefined;
		this.page = undefined;
		const context = this.context;
		this.context = undefined;
		if (context) {
			try {
				await context.close();
			} catch {
				/* shutting down anyway */
			}
		}
		SharedCamoufoxRuntime.instance = undefined;
	}

	private async launch(): Promise<void> {
		mkdirSync(dirname(PROFILE_DIR), { recursive: true });

		const headless = parseHeadless(process.env.YTJS_CAMOUFOX_HEADLESS);
		const headlessLabel =
			headless === "virtual" ? 'virtual (Xvfb + software GL)' : headless ? "true" : "false (headful)";
		console.log(
			`[camoufox] launching headless=${headlessLabel} profile=${PROFILE_DIR}` +
				(process.env.YTJS_CAMOUFOX_HEADLESS ? "" : " (YTJS_CAMOUFOX_HEADLESS unset -> default false)"),
		);
		const context = await Camoufox({
			headless,
			persistent_context: true,
			user_data_dir: PROFILE_DIR,
			// Required for `mw:` evaluations — BotGuard must run in the page's own
			// world exactly as WebView's evaluateJavascript does.
			main_world_eval: true,
			// node:<pid> launch logs are noise; set YTJS_CAMOUFOX_DEBUG=1 to see the
			// generated fingerprint config.
			debug: process.env.YTJS_CAMOUFOX_DEBUG === "1",
		});

		const page = context.pages()[0] ?? (await context.newPage());
		page.setDefaultTimeout(INIT_TIMEOUT_MS);

		// Everything in the sandbox is offline: only the navigation itself is
		// fulfilled (PipePipe's setBlockNetworkLoads(true)).
		await page.route("**/*", async (route) => {
			const request = route.request();
			if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
				try {
					await route.fulfill({
						status: 200,
						contentType: "text/html; charset=utf-8",
						body: RUNTIME_DOCUMENT,
					});
					return;
				} catch {
					/* fall through to abort */
				}
			}
			try {
				await route.abort();
			} catch {
				/* already handled */
			}
		});

		await page.goto("https://www.youtube.com/", { waitUntil: "domcontentloaded" });

		this.context = context;
		this.page = page;

		const ua = await page.evaluate(() => navigator.userAgent);
		if (ua) this.userAgent = ua;
	}

	private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
		return Promise.race([
			promise,
			new Promise<T>((_resolve, reject) =>
				setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
			),
		]);
	}
}

/** Snapshot of the sandbox UA for Node-side request headers. */
export function getRuntimeUserAgent(): string {
	return SharedCamoufoxRuntime.get().getUserAgent();
}

/** Kick the browser launch off early (called from server startup). */
export async function warmUpCamoufox(): Promise<void> {
	await SharedCamoufoxRuntime.get().ensureReady();
}
