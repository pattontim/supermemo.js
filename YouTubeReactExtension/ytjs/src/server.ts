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
	const kindlangRegex = /Kind: (.*)\nLanguage: (.*)\n/;
	return vtt.replace(kindlangRegex, '');
}

// app.use((req, res, next) => {
//     if(req.get('Content-Type') != undefined && req.get('Content-Type').indexOf('utf-8') != -1) {
//         res.set('Content-Type', 'text/html; charset=windows-1252');
//         next();
//     }
// });

app.use(express.static('dist'));

/* Attach our cors proxy to the existing API on the /proxy endpoint. */
app.get('/proxy/:proxyUrl*', (req, res) => {
  req.url = req.url.replace('/proxy/', '/'); // Strip '/proxy' from the front of the URL, else the proxy won't work.
  proxy.emit('request', req, res);
});

app.get('/mpd/invalidate/:v_id', async (req, res) => {
  const v_id = req.params.v_id;
  console.log('invalidating cache for ' + v_id);
  delete dashCache[v_id];
  res.send('OK');
});

app.get(/^\/mpd\/([\w-]+)\.mpd$/, async (req, res) => {
  const v_id = req.params[0]
  const target = req.query.target as string;
  console.log('mpd request for ' + v_id);

  if (archive[v_id]?.file_formats) {
	// TODO serve from archive
  }

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
				  && !format.mime_type.includes('avc1.64002a'));
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

	captionCache[v_id] = videoInfo.captions;
});

app.get('/subtitles/:v_id/:lang', async (req, res) => {
	const v_id = req.params.v_id;
	const lang = req.params.lang;
	console.log('subtitle request for ' + v_id + ' in ' + lang);

	// TODO check if en = auto-generated captions
	if (archive[v_id]?.captions) {
		const captPath = path.join(archiveDir, v_id, 'captions', lang + '.vtt');
		if (existsSync(captPath)) {
			console.log('serving from archive existing caption file');
			res.json({
				"itag": "text/vtt",
				"url": `http://localhost:${port}/archive/${v_id}/captions/${lang}.vtt`
			});
		} else {
			console.log('does not exist in archive');
			res.send('Error: caption not found');
		}
	} else if (captionCache[v_id]) {
		const caption = captionCache[v_id].caption_tracks.find((track) => track.language_code == lang);
		if (caption) {
			console.log('serving from cache fetch');
			// res.send(`${caption.base_url}&fmt=vtt`);
			const ytResponse = await fetch(`${caption.base_url}&fmt=vtt`);
			const vtt = await ytResponse.text();
			// fix content type
			res.set('Content-Type', 'text/vtt');
			res.send(transformWebVTT(vtt));
		} else {
			console.log('does not exist in cache');
			res.send('Error: caption not found');
		}
	} else {
		console.log('does not exist in cache');
		res.send('Error: caption not found');
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
	// write to info.json
	writeFileSync(path.join(dir, 'info.json'), JSON.stringify(newInfo, null, 2));

	if(newInfo.captions) {
	  const captionsDir = path.join(dir, 'captions');
	  if (!existsSync(captionsDir)) {
		mkdirSync(captionsDir);
	  }

	  // fetch via base_url
	  for (const captionTrack of newInfo.captions.caption_tracks) {
		// URL request
		const captionUrl = captionTrack.base_url;
		const captionFile = createWriteStream(path.join(captionsDir, captionTrack.language_code + '.vtt'));
		const captionStream = await fetch(captionUrl + '&fmt=vtt');

		await new Promise((resolve, reject) => {
		  captionStream.body.pipe(captionFile);
		  captionStream.body.on('error', reject);
		  captionStream.body.on('end', resolve);
		});
			
		captionFile.close();
	  }
	}    

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
