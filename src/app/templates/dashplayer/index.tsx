import 'core-js/stable';
import 'regenerator-runtime/runtime';
import React from 'react';
import ReactDOM from 'react-dom/client';
import ReactPlayer from 'react-player/lazy';
import { runtime } from '../../utils/runtime-detector';

/**
 * Bare DASH player for smoke-testing manifests.
 *
 * Loads whatever MPD is given in ?url= (defaults to the Akamai BBB test stream)
 * with the SAME player config SMPlayer uses — react-player/lazy plus
 * runtime.getPlayerConfig() (dash.js 4.5.2 on IE11, 4.7.4 on modern) and the
 * streaming timeouts. No SuperMemo inputs, no /streamUrl, no archive machinery.
 *
 * Modern:  http://localhost:3000/templates/dashplayer.html?url=<mpd>
 * IE11:    http://10.0.2.2:3000/templates/dashplayer.html?url=<mpd>
 * SABR:    ...?url=http://<host>:3000/sabr/<videoId>/master.mpd
 *
 * Served by the /dash route in ytjs (template.route.ts), which just redirects
 * here preserving the url param.
 */
function DashPlayer() {
	const params = new URLSearchParams(window.location.search);
	const url =
		params.get('url') ||
		'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_640x360_800k.mpd';

	console.log('[DashPlayer] loading url:', url);

	return (
		<div style={{ width: '100vw', height: '100vh', background: '#000' }}>
			<ReactPlayer
				className="react-player"
				config={{
					file: {
						...runtime.getPlayerConfig(),
						attributes: {
							crossOrigin: 'true',
							autoPlay: false,
							style: { display: 'block', verticalAlign: 'bottom', width: '100%', height: '100%' },
						},
						// @ts-expect-error react-player's FileConfig type omits the
						// dash.js streaming options (same pattern as SMPlayer.tsx).
						streaming: {
							manifestRequestTimeout: 20000,
							abandonLoadTimeout: 20000,
							timeoutIntervals: {
								MPD: 20000,
								XHRMPDTimeout: 20000,
							},
						},
					},
				}}
				width="100%"
				height="100%"
				url={url}
				playing
				controls
			/>
		</div>
	);
}

ReactDOM.createRoot(document.getElementById('root')!).render(<DashPlayer />);