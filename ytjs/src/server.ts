import express from 'express';
import { Innertube, UniversalCache, Utils, FormatOptions } from 'youtubei.js';

// @ts-ignore
import corsAnywhere from 'cors-anywhere';
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, createWriteStream, writeFileSync } from 'fs';
import path from 'path';
import fetch from 'node-fetch';

import { Archive, ArchiveInfoV1, Cache, CacheInfoV1 } from './utils/archive';
import { Format } from 'youtubei.js/dist/src/parser/misc';

const app = express();
const port = 3000; // You can change the port number if needed

let cacheDir = './.cache';
let archiveDir = './dist/archive';
let yti_version = '0.0.0';
let youtube: Innertube;
let archive = {} as Archive;
let cache = {} as Cache;
let archive_container = 'mp4';

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
 if (archive[v_id]) {		
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
			} catch (error) {
				tries++;
				await new Promise(r => setTimeout(r, interval));
				interval *= 2;
			}
		}
		console.error(`Error fetching: ${baseUrl.href}`);
		console.error(error);
		return null;
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
		console.error(`Error fetching VTT file: ${error.message}`);
		return null;
	}
}

// app.use((req, res, next) => {
//     if(req.get('Content-Type') != undefined && req.get('Content-Type').indexOf('utf-8') != -1) {
//         res.set('Content-Type', 'text/html; charset=windows-1252');
//         next();
//     }
// });

app.use(express.static('dist'));

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

app.get(/^\/mpd\/([\w-]+)\.mpd$/, async (req, res) => {
  const v_id = req.params[0]
  const target = req.query.target as string;
  console.log('mpd request for ' + v_id);

  // TODO heuristic, for now it seems to generally be 6 hours
  if (cache[v_id] && cache[v_id].mpd_manifest && (Date.now() - cache[v_id].cached_on_ms < 1000 * 60 * 60 * 6) && cache[v_id].browser_target == target) {
	console.log('serving from cache');
	res.send(cache[v_id].mpd_manifest);
	return;
  }

  const videoInfo = await youtube.getBasicInfo(v_id);
  let manifest: string;

  // TODO better match the format to the browser
  try {
	  if (target == "IE") {
		  manifest = await videoInfo.toDash((url) => new URL(`http://localhost:${port}/proxy/${url}`)
			  , (format) => 
			         !format.mime_type.includes('mp4a.40.5')  //  599 m4a audio only | mp4a.40.5 22050Hz ultralow, m4a_dash
			  	  && !format.mime_type.includes('avc1.4d4015')  // 133 mp4 426x240 30 | avc1.4d4015 240p, mp4_dash		
			      && !format.mime_type.includes('avc1.4d401e') // 134 mp4 640x360 30 | avc1.4d401e 360p, mp4_dash
			        && !format.mime_type.includes('mp4a.40.2') // 140 m4a audio only | mp4a.40.2 44100Hz medium, m4a_dash
				&& !format.mime_type.includes('avc1.4d401f') // 135 mp4 854x480 30 | avc1.4d401f 480p, mp4_dash
				  && !format.mime_type.includes('avc1.4d4020') // 298 mp4 1280x720 60 | avc1.4d4020 720p60, mp4_dash
				  && !format.mime_type.includes('avc1.64002a') // 299 mp4 1920x1080 60 | avc1.64002a 1080p60, mp4_dash
				  && !format.mime_type.includes('avc1.64001f') // 720p > H.264	- High Profile - Level 3.1
				  && !format.mime_type.includes('avc1.640028') // 1080p > H.264	- High Profile - Level 4.0
				  );
	  } else {
		  manifest = await videoInfo.toDash((url) => new URL(`http://localhost:${port}/proxy/${url}`));
	  }
	
	res.send(manifest);
  } catch (InnertubeError) {
	console.log('error: ' + InnertubeError);
	res.send('Error: ' + InnertubeError);
	return;
  }

  try {
  	for (const caption of videoInfo?.captions?.caption_tracks ?? []) {
    	caption.base_url = `http://localhost:${port}/fixvtt/${caption.base_url}`;
  	}
	// TypeError possible
  } catch (error) {
	if (error instanceof TypeError) {
	  console.log('TypeError, very likely captions disabled.' );
	} else {
	  console.log('error: ' + error);
	}
  } finally {
	// wait 2000ms before caching the full video info
	await new Promise(r => setTimeout(r, 2000));
	const videoInfoFull = await youtube.getInfo(v_id);
	videoInfoFull.captions = videoInfo.captions;
	cache[v_id] = new CacheInfoV1(videoInfoFull, manifest, target, yti_version);
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
			res.status(404).send('Not found');
			return;
		}
		res.set('Content-Type', 'text/vtt');
		res.send(vtt);
	} catch (error) {
		console.log('error: ' + error);
		res.send('Error: ' + error);
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
	res.send(vid_formats[0]);
  } else {
	const videoInfoFull = await youtube.getInfo(v_id);
	const best_format = {
	  type: 'video+audio', // audio, video or video+audio
	  quality: 'best', // best, bestefficiency, 144p, 240p, 480p, 720p and so on.
	  format: 'mp4' // media container format 
	} as FormatOptions;

	// assume chooseFormat is used internally deterministically
	const format = await videoInfoFull.chooseFormat(best_format);
	const fileNameItag = format.itag + '.' + archive_container; // for now
	const stream = await videoInfoFull.download(best_format);
	const fileFormats: {[key: string]: Format} = {};
	fileFormats[format.itag + '.' + archive_container] = format;

	console.log('downloading video')
	const dir = path.join(archiveDir, v_id);
	if (!existsSync(dir)) {
	  mkdirSync(dir);
	}

	const file = createWriteStream(path.join(dir, fileNameItag));
	for await (const chunk of Utils.streamToIterable(stream)) {
	  file.write(chunk);
	}
	file.close();

	const newInfo = new ArchiveInfoV1(videoInfoFull, yti_version); 

	if(newInfo.captions) {
	  const captionsDir = path.join(dir, 'captions');
	  if (!existsSync(captionsDir)) {
		mkdirSync(captionsDir);
	  }

	  // fetch via base_url
	  for (const captionTrack of newInfo.captions?.caption_tracks ?? []) {
		// URL request
		const captionUrl = new URL(captionTrack.base_url);
		captionUrl.searchParams.set('fmt', 'vtt');
		const captionStream = await fetchWait(captionUrl, true, 500, 50);

		if (captionStream == null || captionStream.status !== 200   ) {
		  console.log('error: ' + captionStream?.status);
		  res.send('Error: ' + captionStream?.status);
		  return;
		}

		const captionFile = createWriteStream(path.join(captionsDir, captionTrack.language_code + '.vtt'));

		await new Promise((resolve, reject) => {
		  captionStream.body.pipe(captionFile);
		  captionStream.body.on('error', reject);
		  captionStream.body.on('end', resolve);
		});
			
		captionFile.close();
		const preFix = "http://localhost:" + port + "/fixvtt/";		
		const fsUrl = `http://localhost:${port}/archive/${v_id}/captions/${captionTrack.language_code}.vtt`;
		captionTrack.base_url = preFix + fsUrl;
	  }
	}    

	writeFileSync(path.join(dir, 'info.json'), JSON.stringify(newInfo, null, 2));

	archive[v_id] = newInfo;
	res.send('OK');
  }
});

app.listen(port, async () => {  
  if (!existsSync(cacheDir)) {
	mkdirSync(cacheDir);
  }

  youtube = await Innertube.create({
	cache: new UniversalCache(true, cacheDir),
	generate_session_locally: true,
  });


  if (!existsSync(archiveDir)) {
	mkdirSync(archiveDir);
  } else {
	loadJsonFilesIntoArchive(archiveDir, archive);
  }

  try {
	throw new Utils.InnertubeError('This is thrown to get the version of youtubei.js');
  } catch (error) {
	if (error instanceof Utils.InnertubeError) {
	  yti_version = error.version;
	}
  }

  console.log(`Server listening on port ${port}`);
});
