import express from 'express';
import { Innertube, UniversalCache, Utils } from 'youtubei.js';

// @ts-ignore
import corsAnywhere from 'cors-anywhere';
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, createWriteStream, writeFileSync } from 'fs';
import path from 'path';
import fetch, { Response } from 'node-fetch';

import { Archive, ArchiveInfoV1, Cache, CacheInfoV1 } from './utils/archive';
import { Format } from 'youtubei.js/dist/src/parser/misc';
import { FormatOptions } from 'youtubei.js/dist/src/types/FormatUtils';
import { VideoInfo } from 'youtubei.js/dist/src/parser/youtube';
import { PlayerCaptionsTracklist } from 'youtubei.js/dist/src/parser/nodes';
import { ElementInfo, ElementInfoV1 } from './utils/element';

const app = express();
const port = 3000; // You can change the port number if needed

let cacheDir = './.cache';
let archiveDir = './dist/archive';
let elementsDir = './dist/elements';
let yti_version = '0.0.0';
let youtube: Innertube;
let archive = {} as Archive;
let cache = {} as Cache;
let archiveContainer = 'mp4';
let online = false;
let onlineTimeoutMs = 10000;

const proxy = corsAnywhere.createServer({
	originWhitelist: [], // Allow all origins
	requireHeaders: [], // Do not require any headers.
	removeHeaders: [] // Do not remove any headers.
});

// TODO better match the format to the browser
const formatMap = {
	'IE': ['avc1.4d401f', 'mp4a.40.2'],
	'Chrome': ['avc1.4d401f', 'mp4a.40.2'],
	'Firefox': ['avc1.4d401f', 'opus'],
	'Edge': ['avc1.4d401f', 'mp4a.40.2']
};

const formatsToUse = [
	// 599 m4a audio only | mp4a.40.5 22050Hz ultralow, m4a_dash
	'mp4a.40.5',
	// 133 mp4 426x240 30 | avc1.4d4015 240p, mp4_dash
	'avc1.4d4015',
	// 134 mp4 640x360 30 | avc1.4d401e 360p, mp4_dash
	'avc1.4d401e',
	// 140 m4a audio only | mp4a.40.2 44100Hz medium, m4a_dash
	'mp4a.40.2',
	// 135 mp4 854x480 30 | avc1.4d401f 480p, mp4_dash
	'avc1.4d401f',
	// 298 mp4 1280x720 60 | avc1.4d4020 720p60, mp4_dash
	'avc1.4d4020',
	// 299 mp4 1920x1080 60 | avc1.64002a 1080p60, mp4_dash
	'avc1.64002a',
	// 720p > H.264 - High Profile - Level 3.1
	'avc1.64001f',
	// 1080p > H.264 - High Profile - Level 4.0
	'avc1.640028',
];

const getBrowserName = (userAgent: string) => {
	if (userAgent.includes('Edge')) {
		return 'Edge';
	} else if (userAgent.includes('Firefox')) {
		return 'Firefox';
	} else if (userAgent.includes('Chrome')) {
		return 'Chrome';
	} else if (userAgent.includes('Trident')) {
		return 'IE';
	} else {
		return 'Unknown';
	}
};

function loadJsonFilesIntoArchive(archiveDir: string, archive: Archive) {
	const files = readdirSync(archiveDir);

	files.forEach((file) => {
		const filePath = path.join(archiveDir, file);
		const stats = statSync(filePath);

		if (stats.isDirectory()) {
			loadJsonFilesIntoArchive(filePath, archive);
		} else if (file === 'info.json') {
			const key = path.basename(archiveDir);
			const jsonContent = readFileSync(filePath, 'utf-8');

			try {
				const jsonData: ArchiveInfoV1 = JSON.parse(jsonContent);
				archive[key] = jsonData;
			} catch (error) {
				console.error(`Failed to parse JSON file: ${filePath}`);
				console.error(error);
			}
		}
	});
}

function transformWebVTT(vtt: string) {
	const kindRegex = /Kind: (.*)\n/;
	const langKindRegex = /Language: (.*)\n/;
	return vtt.replace(kindRegex, '').replace(langKindRegex, '');
}

async function getCacheWait(v_id: string, retry: boolean = true, interval: number = 100, timeout = 10000) {
	if (!online || archive[v_id]) {
		return archive[v_id];
	} else if (cache[v_id]) {
		return cache[v_id];
	} else if (retry) {
		console.log(`Waiting for cache: ${v_id}, retry: ${retry}, interval: ${interval}, timeout: ${timeout}`);
		let start = Date.now();
		while (!cache[v_id] && Date.now() - start < timeout) {
			await new Promise(r => setTimeout(r, interval));
		}
		return cache[v_id] ? cache[v_id] : null;
	}
}

async function fetchWait(url: URL, retry: boolean = true, timeout = -1, interval: number = 1000) {
	const baseUrl = new URL(url.href); 	
	try {
		const res = await fetch(baseUrl.href);
		return res;
	} catch (error) {
		// TODO stepback algorithm
		let tries = 0;
		let start = Date.now();
		while (tries < 6 && retry && (timeout == -1 || Date.now() - start < timeout)) {
			try {
				const res = await fetch(baseUrl.href);
				return res;
			} catch (fetchError) {
				error = fetchError;
				tries++;
				await new Promise(r => setTimeout(r, interval));
				interval *= 2;
			}
		}
		throw error;
	}

}

async function fetchTransformedVTT(url: URL) {
	const baseUrl = new URL(url.href);
	baseUrl.searchParams.set('fmt', 'vtt');

	try {
		// it is assumed that dashjs/HTML will retry on failure
		const res = await fetchWait(baseUrl, false);

		if (res == null) {
			return null;
		}

		const text = await res.text();
		return transformWebVTT(text);
	} catch (error: any) {
		// console.error(`Error fetching VTT file: ${error.message}`);
		// return null;
		throw error;
	}
}

// I have a hunch this disables some slow SM caching mechanisms
const setNoCacheHeaders = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) => {
  // Set Cache-Control header to prevent caching
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  // Set Pragma header to prevent caching in old HTTP/1.0 clients
  res.setHeader('Pragma', 'no-cache');

  // Set Expires header to a past date to ensure no caching
  res.setHeader('Expires', '0');

  // Continue to the next middleware
  next();
};


app.use(express.static('dist'), setNoCacheHeaders);

/* Attach our cors proxy to the existing API on the /proxy endpoint. */
app.get('/proxy/:proxyUrl*', async (req, res) => {
  req.url = req.url.replace('/proxy/', '/'); // Strip '/proxy' from the front of the URL, else the proxy won't work.
  proxy.emit('request', req, res);
});

app.get('/mpd/invalidate/:v_id', async (req, res) => {
  const v_id = req.params.v_id;
  console.log('invalidating mpd cache for ' + v_id);
  cache[v_id].mpd_manifest = "";
  res.send('OK');
});

app.get('/templateUrl/:id', async (req, res) => {
	const id = req.params.id;
	if(id.length == 11){
		res.send(`http://localhost:${port}/index.html`);
		return;
	}

	// open FS at elements/id and read info.json, return its HTML
	// patch together and send
	const dir = path.join(elementsDir, id);
	if (!existsSync(dir)) {
		res.status(404).send('Not found: ' + dir);
		return;
	}
	const info = JSON.parse(readFileSync(path.join(dir, 'info.json'), 'utf-8')) as ElementInfo;

	// open at templates/id.html and ret the template
	// const template = JSON.parse(readFileSync(path.join(archiveDir, 'templates', info.templateId + '.json'), 'utf-8'));

	res.send(`http://localhost:${port}/templates/${info.templateId}.html`);
});

// TODO quality selection
app.get('/streamUrl/:v_id', async (req, res) => {
  const v_id = req.params.v_id;
  const start = req.query.startSec;
  const stop = req.query.stopSec;
  const target = req.query.target;
  if (!start || !stop || !target) {
	res.status(400).send('Missing start, stop, or target');
	return;
  }

  const archiveFormats = archive[v_id]?.file_formats;
  if (archiveFormats) {
	
	// const bestFormat = Array.from(Object.values(archive[v_id].file_formats)).sort((a, b) => b.bitrate - a.bitrate)[0]; 
	const bestKey = Object.keys(archive[v_id].file_formats).sort((a, b) => archiveFormats[a].bitrate - archiveFormats[b].bitrate)[0];
	const bestFormat = archiveFormats[bestKey];

	if (bestFormat) {
		const url = new URL(`http://localhost:${port}/archive/${v_id}/${bestKey}`);
		res.send(url.href);
		return;
	}
  } else {
	const url = new URL(`http://localhost:${port}/mpd/${v_id}.mpd`);
	url.searchParams.set('target', target as string);
	res.send(url.href + "#" + start + "," + stop);
  }
});

app.get('/archiveInfo/:v_id', async (req, res) => {
	const v_id = req.params.v_id;
	const archiveInfo = await getCacheWait(v_id);
	if (archiveInfo) {
		res.send(archiveInfo);
	} else {
		res.status(404).send({});
	}	
});	

async function getSupportedFormats(videoInfoFull: VideoInfo) {
	const supported =  [
		{
			type: 'video+audio', // audio, video or video+audio
			quality: '1080p', // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
			format: 'mp4' // media container format 
		}, 
		{
			type: 'video+audio', // audio, video or video+audio
			quality: '720p', // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
			format: 'mp4' // media container format 
		},
		{
			type: 'video+audio', // audio, video or video+audio
			quality: '480p', // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
			format: 'mp4' // media container format 
		},
		{
			type: 'video+audio', // audio, video or video+audio
			quality: '360p', // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
			format: 'mp4' // media container format 
		},
		{
			type: 'video+audio', // audio, video or video+audio
			quality: '240p', // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
			format: 'mp4' // media container format 
		},
		{
			type: 'video+audio', // audio, video or video+audio
			quality: '144p', // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
			format: 'mp4' // media container format 
		},
	] as FormatOptions[];

	const fileFormats: { [key: string]: Format } = {};

	for (const formatOpt of supported) {
		// assume chooseFormat is used internally deterministically
		try {
			const format = await videoInfoFull.chooseFormat(formatOpt);
			fileFormats[format.itag + '.' + archiveContainer] = format;
		} catch (error) {
			console.log('failed to get format: ' + error);
			continue;
		}
	}

	return fileFormats;
}

app.get('/archivei/', async (req, res) => {
	res.send(archive);
});

app.get('/cachei/', async (req, res) => {
	res.send(cache);
});

app.get(/^\/mpd\/([\w-]+)\.mpd$/, async (req, res) => {
	const v_id = req.params[0]
	const target = req.query.target as string;
	console.log('mpd request for ' + v_id);

	// TODO heuristic, for now it seems to generally be 6 hours
	if (cache[v_id] && cache[v_id].mpd_manifest && (Date.now() - cache[v_id].cached_on_ms < 1000 * 60 * 60 * 6) && cache[v_id].browser_target == target) {
		console.log('serving from cache');
		res.status(200).send(cache[v_id].mpd_manifest);
		return;
	}

	if(youtube == undefined){
		try {
			console.log("Attempting Innertube reconnect...")
			youtube = await callRejectAfter(connectInnertube(), onlineTimeoutMs/3).catch() as Innertube 
			console.log("Successfully reconnected.")
			online = true
		} catch(error) {
			console.log("network still down.")
			res.status(504).send('Error: ' + error);
			return
		}
	}

	let videoInfo: VideoInfo;
	try {
		videoInfo = await youtube.getBasicInfo(v_id);
	} catch (error) {
		console.log('error: ' + error);
		console.log('failed to get basic info');
		res.status(503).send('Error: ' + error);
		return;
	}
	let manifest: string;

	// TODO better match the format to the browser
	try {
		if (target == "IE") {
			manifest = await videoInfo.toDash((url: any) => new URL(`http://localhost:${port}/proxy/${url}`)
				, (format: any) => !formatsToUse.find(fmt => format.mime_type.includes(fmt))
			);
		} else {
			manifest = await videoInfo.toDash((url: any) => new URL(`http://localhost:${port}/proxy/${url}`));
		}
		res.send(manifest);
	} catch (error) {
		console.log('error: ' + error);
		console.log('failed to get manifest');
		res.status(503).send('Error: ' + error);
		if(videoInfo.basic_info.is_private){
			console.log('Private video! Please remove!');
			return;
		}
		return;
	}

	try {
		for (const caption of videoInfo?.captions?.caption_tracks ?? []) {
			caption.base_url = `http://localhost:${port}/fixvtt/${caption.base_url}`;
		}
		// TypeError possible
	} catch (error) {
		console.log('failed to get captions');
		if (error instanceof TypeError) {
			console.log('TypeError, very likely captions disabled.');
		} else {
			console.log('error: ' + error);
		}
	}
	// wait 2000ms before caching the full video info
	if (!cache[v_id]) {
		new Promise(r => setTimeout(r, 2000)).then(async () => {
			try {
				const videoInfoFull = await youtube.getInfo(v_id);
				videoInfoFull.captions = videoInfo.captions;
				cache[v_id] = new CacheInfoV1(videoInfoFull, manifest, target, yti_version);
				// TODO update to use video_sets instead of file_formats
				cache[v_id].file_formats = await getSupportedFormats(videoInfoFull);
			} catch (error) {
				console.log('Error: ' + error);
				console.log('failed to cache full video info');
			}
		})
	}
});

app.get('/captions/:v_id', async (req, res) => {
	const v_id = req.params.v_id;
	let captionTracks = (await getCacheWait(v_id))?.captions

	if (captionTracks) {
		console.log('serving caption from cache or archive');
		res.json(captionTracks.caption_tracks);
		return;
	}
	res.json({});
});

app.get('/fixvtt/*', async (req, res) => {
	const url = new URL(req.url.replace('/fixvtt/', ''));
	try {
		const vtt = await fetchTransformedVTT(url);
		if (vtt == null) {
			res.status(503).send('Error: the VTT could not be found on the service by URL.');
			return;
		}
		res.set('Content-Type', 'text/vtt');
		res.send(vtt);
	} catch (error) {
		console.log('error: ' + error);
		res.status(503).send('Error: ' + error);
	} 
});

app.get('/formats/:v_id', async (req, res) => {
	const v_id = req.params.v_id;
	const formats = (await getCacheWait(v_id))?.file_formats;
	if (formats) {
		res.json(formats);
	} else {
		res.json({});
	}
});

app.get('/archive/:v_id', async (req, res) => {
	const v_id = req.params.v_id;
	console.log('archive request for ' + v_id);

	if (archive[v_id]?.file_formats) {
		const vid_files = Object.keys(archive[v_id].file_formats);
		const vid_formats = vid_files.map((file) => {
			return {
				"itag": file,
				"url": `http://localhost:${port}/archive/${v_id}/${file}`
			}
		});
		// vid_formats.sort((a, b) => Number.parseInt(a.itag.split('.')[0]) - b.itag.split('.')[0]);
		res.status(200).send(vid_formats[0]);
	} else {
		let videoInfoFull: VideoInfo
		try {
			videoInfoFull = await youtube.getInfo(v_id);
		} catch (error) {
			console.log('error: ' + error);
			res.status(503).send('Error: ' + error);
			return;
		}
		const best_format = {
			type: req.query.type ? req.query.type : 'video+audio', // audio, video or video+audio
			quality: req.query.quality ? req.query.quality : 'best', // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
			format: req.query.format ? req.query.format : 'mp4' // media container format 
		} as FormatOptions;

		// assume chooseFormat is used internally deterministically
		let format = await videoInfoFull.chooseFormat(best_format);

		if(!(format.has_video && format.has_audio)){
			console.log('Error: format does not have video and audio, up/downgrading to best quality');
			const best_format = {
				type: 'video+audio', // audio, video or video+audio
				quality: 'best', // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
				format: 'mp4' // media container format 
			} as FormatOptions;
			format = await videoInfoFull.chooseFormat(best_format);
		}

		const fileNameItag = format.itag + '.' + archiveContainer; // for now

		let stream;
		try {
			stream = await videoInfoFull.download(best_format);
		} catch (error) {
			console.log('error: ' + error);
			res.status(503).send('Error: ' + error);
			return;
		}
		const fileFormats: { [key: string]: Format } = {};
		fileFormats[format.itag + '.' + archiveContainer] = format;

		console.log('downloading video, format ' + format.quality_label + ' ' + format.itag)
		const dir = path.join(archiveDir, v_id);
		if (!existsSync(dir)) {
			try {
				mkdirSync(dir);
			} catch (error) {
				console.log('error: ' + error);
				res.status(507).send('Error: ' + error);
				return;
			}
		}
		
		try {
			const file = createWriteStream(path.join(dir, fileNameItag));
			for await (const chunk of Utils.streamToIterable(stream)) {
				file.write(chunk);
			}
			file.close();
		} catch (error) {
			console.log('error: ' + error);
			res.status(507).send('Error: ' + error);
			return;
		} finally {
			stream.cancel();
		}

		let newInfo;
		try {
			newInfo = new ArchiveInfoV1(videoInfoFull, yti_version);
		} catch (error) {
			console.log('error: ' + error);
			res.status(503).send('Error: ' + error);
			return;
		}
		newInfo.file_formats = fileFormats;

		if (newInfo.captions) {
			const captionsDir = path.join(dir, 'captions');
			if (!existsSync(captionsDir)) {
				try {
					mkdirSync(captionsDir);
				} catch (error) {
					console.log('error: ' + error);
					res.status(507).send('Error: ' + error);
					return;
				}
			}

			// fetch via base_url
			let captionTracks = [] as PlayerCaptionsTracklist["caption_tracks"];
			try {
				captionTracks = newInfo.captions?.caption_tracks ?? [];
			} catch (error) {
				console.log('error: ' + error);
				res.status(503).send('Error: ' + error);
				return;
			}
			for (const captionTrack of captionTracks ?? []) {
				// URL request
				const captionUrl = new URL(captionTrack.base_url);
				captionUrl.searchParams.set('fmt', 'vtt');
				let captionStream: Response;
				try {
					captionStream = await fetchWait(captionUrl, true, 500, 50);
				} catch (error) {
					console.log('error: ' + error);
					res.status(503).send('Error: ' + error);
					return;
				}
				if (captionStream.status !== 200) {
					console.log('error in caption stream, code: ' + captionStream?.status);
					res.status(503).send('Error: ' + captionStream?.status);
					return;
				}
				
				try {
					const captionFile = createWriteStream(path.join(captionsDir, captionTrack.language_code + '.vtt'));
					await new Promise((resolve, reject) => {
						captionStream.body.pipe(captionFile);
						captionStream.body.on('error', reject);
						captionStream.body.on('end', resolve);
					});
					captionFile.close();
				} catch (error) {
					console.log('error: ' + error);
					res.status(507).send('Error: ' + error);
					return;
				}
				const preFix = "http://localhost:" + port + "/fixvtt/";
				const fsUrl = `http://localhost:${port}/archive/${v_id}/captions/${captionTrack.language_code}.vtt`;
				captionTrack.base_url = preFix + fsUrl;
			}
		}

		try {
			writeFileSync(path.join(dir, 'info.json'), JSON.stringify(newInfo, null, 2));
		} catch (error) {
			console.log('error: ' + error);
			res.status(507).send('Error: ' + error);
			return;
		}
		archive[v_id] = newInfo;
		res.status(200).send('OK');
	}

});

async function callRejectAfter(call: Promise<unknown>, timeMs: number) {
	return Promise.race([
			call,
			new Promise((resolve, reject) => setTimeout(() => { reject() }, timeMs))
		])
}

function connectInnertube() {
	return Innertube.create({
		cache: new UniversalCache(true, cacheDir),
		generate_session_locally: true,
	})
}

function startServer() {
	app.listen(port, async () => {
		try {
			throw new Utils.InnertubeError('This is thrown to get the version of youtubei.js');
		} catch (error) {
			if (error instanceof Utils.InnertubeError) {
				yti_version = error.version;
			}
		}	

		if (!existsSync(cacheDir)) {
			mkdirSync(cacheDir);
		}

		setTimeout(async () => {
			console.log("Attempting to create Innertube instance...")
			try {
				// youtube = await createInnertubeRejectAfter(onlineTimeoutMs).catch()
				youtube = await callRejectAfter(connectInnertube(), onlineTimeoutMs).catch() as Innertube
				online = true;
				console.log("Innertube instance created successfully.")
			} catch {
				online = false;
				console.log("Innertube could not be fetched. Running in offline (archive only) mode...")
			}
		})		

		// TODO support symlink
		if (!existsSync(archiveDir)) {
			mkdirSync(archiveDir);
			console.log("created a new archive")
		} else {
			loadJsonFilesIntoArchive(archiveDir, archive);
			console.log("loaded archive: " + Object.keys(archive).length + " videos")
		}
		const curDir = process.cwd();
		console.log(`Video archive loaded using path: ${path.join(curDir, archiveDir)}`)
	});
}

startServer()
