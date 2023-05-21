import express, { Request, Response } from 'express';
import { Innertube, UniversalCache } from 'youtubei.js';
import corsAnywhere from 'cors-anywhere';

const app = express();
const port = 3000; // You can change the port number if needed

let dashCache = {};

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

let youtube: Innertube;
const youtubePromise = Innertube.create({
    cache: new UniversalCache(true, './.cache')
});

youtubePromise.then((yt) => {
    console.log('youtubei.js ready');
    youtube = yt;
});

app.use(express.static('dist'));

/* Attach our cors proxy to the existing API on the /proxy endpoint. */
app.get('/proxy/:proxyUrl*', (req, res) => {
    req.url = req.url.replace('/proxy/', '/'); // Strip '/proxy' from the front of the URL, else the proxy won't work.
    proxy.emit('request', req, res);
});

app.get(/^\/mpd\/([\w-]+)\.mpd$/, async (req, res) => {    
    const v_id = req.params[0]
    console.log('mpd request for ' + v_id);
    // const youtube = await Innertube.create();

    if(dashCache[v_id]) {
        console.log('serving from cache');
        res.send(dashCache[v_id]);
        return;
    }

    const videoInfo = await youtube.getBasicInfo(v_id);
    
    // TODO better match the format to the browser
    // const browserName = getBrowserName(req.headers['user-agent'] as string);
    // const format = formatMap[browserName];
    const manifest = await videoInfo.toDash((url) => new URL(`http://localhost:${port}/proxy/${url}`)
    , (format) => !format.mime_type.includes('avc1.4d401e') && !format.mime_type.includes('mp4a.40.2'));
    // , (format) => format.itag != 134 && format.itag != 140);

    dashCache[v_id] = manifest;
    res.send(manifest);
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
