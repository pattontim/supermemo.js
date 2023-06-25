import express from 'express';
import { Innertube, UniversalCache, Utils, FormatOptions } from 'youtubei.js';
import corsAnywhere from 'cors-anywhere';
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, createWriteStream, writeFileSync } from 'fs';
import path from 'path';
import { Format } from 'youtubei.js/dist/src/parser/misc';
import { PlayerCaptionsTracklist } from 'youtubei.js/dist/src/parser/nodes';
import fetch from 'node-fetch';

const app = express();
const port = 3000; // You can change the port number if needed

let dashCache = {};
let captionCache: { [id: string] : PlayerCaptionsTracklist; } = {};
let cacheDir = './.cache';
let archiveDir = './dist/archive';
let version = '0.0.0';
let youtube: Innertube;
let archive = {} as Archive;
let archive_container = 'mp4';

const proxy = corsAnywhere.createServer({
  originWhitelist: [], // Allow all origins
  requireHeaders: [], // Do not require any headers.
  removeHeaders: [] // Do not remove any headers.
});

interface ArchiveInfo {
  captions?: PlayerCaptionsTracklist;  
  game_info?: any;
  // primary_info
  title: string;
  published: string;
  relative_date: string;
  // secondary_info
  author_name: string; // owner.author.name
  author_channel_id: string; // owner.author.id
  author_channel_url: string; // owner.author.url
  description: string; // description

  yti_version: string;
  file_formats: { [filename: string]: Format };
}

interface Archive {
  [key: string]: ArchiveInfo;
}

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
		const jsonData: ArchiveInfo = JSON.parse(jsonContent);
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

function getCaptionCache(v_id: string) {
 if (captionCache[v_id]) {
   return captionCache[v_id];
 } else if (archive[v_id] && archive[v_id].captions) {		
   return archive[v_id].captions;
 }
}

function fetchTransformedVTT(url: URL) {
  const baseUrl = new URL(url.href);
  baseUrl.searchParams.set('fmt', 'vtt');

  return fetch(baseUrl.href)
	.then(res => res.text())
	.then(text => transformWebVTT(text));
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
  console.log('invalidating cache for ' + v_id);
  delete dashCache[v_id];
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

app.get(/^\/mpd\/([\w-]+)\.mpd$/, async (req, res) => {
  const v_id = req.params[0]
  const target = req.query.target as string;
  console.log('mpd request for ' + v_id);

  // TODO heuristic, for now it seems to generally be 6 hours
  if (dashCache[v_id] && (Date.now() - dashCache[v_id].timestamp < 1000 * 60 * 60 * 6) && dashCache[v_id].target == target) {
	console.log('serving from cache');
	res.send(dashCache[v_id].manifest);
	return;
  }

  const videoInfo = await youtube.getBasicInfo(v_id);

  // TODO better match the format to the browser
  try {
	let manifest: string;
	  if (target == "IE") {
		  manifest = await videoInfo.toDash((url) => new URL(`http://localhost:${port}/proxy/${url}`)
			  , (format) => !format.mime_type.includes('avc1.4d401e') && !format.mime_type.includes('mp4a.40.2')
				  && !format.mime_type.includes('avc1.4d401f') && !format.mime_type.includes('avc1.4d4020')
				  && !format.mime_type.includes('avc1.64002a')
				  && !format.mime_type.includes('avc1.64001f')
				  && !format.mime_type.includes('avc1.640028')
				  );
	  } else {
		  manifest = await videoInfo.toDash((url) => new URL(`http://localhost:${port}/proxy/${url}`));
	  }
	
	dashCache[v_id] = { "manifest": manifest, "timestamp": Date.now(), "target": target };
	res.send(manifest);
  } catch (InnertubeError) {
	console.log('error: ' + InnertubeError);
	res.send('Error: ' + InnertubeError);
	return;
  }

  try {
  	for (const caption of videoInfo?.captions?.caption_tracks) {
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
	captionCache[v_id] = videoInfo.captions;
  }
});

app.get('/captions/:v_id', async (req, res) => {
	const v_id = req.params.v_id;
	const captionTracks = getCaptionCache(v_id);

	if (captionTracks) {
		console.log('serving caption from cache');
		res.json(captionTracks.caption_tracks);
		return;
	} else {
		console.log('caption tracks not found');
	}
	res.json({});
});

app.get('/fixvtt/*', async (req, res) => {
	const url = new URL(req.url.replace('/fixvtt/', ''));
	const vtt = await fetchTransformedVTT(url);

	res.set('Content-Type', 'text/vtt');
	res.send(vtt);
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
	const fileFormats = {};
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

	// TODO write JSON
	const newInfo: ArchiveInfo = {
	  "captions": videoInfoFull?.captions,
      "game_info": videoInfoFull?.game_info,

	  "title": videoInfoFull.primary_info.title.text,
	  "published": videoInfoFull.primary_info.published.text,
	  "relative_date": videoInfoFull.primary_info.relative_date.text,

	  "author_name": videoInfoFull.secondary_info.owner.author.name,
	  "author_channel_id": videoInfoFull.secondary_info.owner.author.id,
	  "author_channel_url": videoInfoFull.secondary_info.owner.author.url,
	  "description": videoInfoFull.secondary_info.description.text,

	  "file_formats": fileFormats,
	  "yti_version": version
	};

	if(newInfo.captions) {
	  const captionsDir = path.join(dir, 'captions');
	  if (!existsSync(captionsDir)) {
		mkdirSync(captionsDir);
	  }

	  // fetch via base_url
	  for (const captionTrack of newInfo.captions.caption_tracks) {
		// URL request
		const captionUrl = new URL(captionTrack.base_url);
		captionUrl.searchParams.set('fmt', 'vtt');
		const captionFile = createWriteStream(path.join(captionsDir, captionTrack.language_code + '.vtt'));
		const captionStream = await fetch(captionUrl.href);

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

	captionCache[v_id] = newInfo.captions;
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
	  version = error.version;
	}
  }

  console.log(`Server listening on port ${port}`);
});
