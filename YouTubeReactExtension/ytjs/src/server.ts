import express, { Request, Response } from 'express';
import { Innertube, UniversalCache } from 'youtubei.js';
import corsAnywhere from 'cors-anywhere';

const app = express();
const port = 3000; // You can change the port number if needed

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
    cache: new UniversalCache(true)
});

youtubePromise.then((yt) => {
    console.log('youtubei.js ready');
    youtube = yt;
});

/* Attach our cors proxy to the existing API on the /proxy endpoint. */
app.get('/proxy/:proxyUrl*', (req, res) => {
    req.url = req.url.replace('/proxy/', '/'); // Strip '/proxy' from the front of the URL, else the proxy won't work.
    proxy.emit('request', req, res);
});

app.get('/', (req: Request, res: Response) => {
  res.send('Hello, World!');
});

app.get('/mpd/:v_id', async (req, res) => {    
    const { v_id } = req.params;
    console.log('mpd request for ' + v_id);
    // const youtube = await Innertube.create();
    const videoInfo = await youtube.getInfo(v_id);
    
    // TODO better match the format to the browser
    // const browserName = getBrowserName(req.headers['user-agent'] as string);
    // const format = formatMap[browserName];
    const manifest = await videoInfo.toDash((url) => new URL(`http://localhost:${port}/proxy/${url}`)
    , (format) => !format.mime_type.includes('avc1.4d401e') && !format.mime_type.includes('mp4a.40.2'));
    // , (format) => format.itag != 134 && format.itag != 140);
    res.send(manifest);
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
