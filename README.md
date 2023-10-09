
# SuperMemo.js

SuperMemo extract extension engine. Allows user to embed different types of React components directly in supermemo. See supported components.

## Supported Components [to be expanded]

### YouTube

Fixes SuperMemo memleaks and slowdowns in video elements using a react app implementation. React-player is used to extend the functionality of incremental video in SM-18. Other types will be supported in the future. 

I now consider this a beta and usable, it won't overwrite your cards under expected operation. However, I recommend that you [backup your collection](https://www.supermemo.wiki/en/supermemo/backup-guide) before starting to use this extension.

![Screenshot](main-screen.png)

## Getting Started

### Dependencies

* SuperMemo 18
* Windows 
* NodeJS
* npm

### Quick start

* backup YouTube.htm in your install SuperMemo/bin folder (Usually C:/SuperMemo/bin)

* copy YouTube.htm from this folder over C:/SuperMemo/bin/YouTube.htm, overwriting it

* run `npm install` in supermemo.js root folder

* cd to ytjs folder

* run `npm install` again to install deps for the ytjs server

* cd to root folder

* run `npm run build` to build the react app

* run `npm run ytjs` to start the video server

* import a YT video in supermemo using CTRL+N


## Building the react app

Run `npm run build` in the root folder

## How it works

We are capable of loading videos from youtube more quickly. The server does this by running a server with a cached [youtubei.js Innertube](https://github.com/LuanRT/YouTube.js) player and serving the MPD to the player for streaming.

## Using youtube video archive feature

You can archive videos and they'll be loaded instead of from youtube. To do this, in your browser go to http://localhost:3000/archive/<youtube_id_here>/ and wait until you get an OK message. From that point on, the video will be loaded from file storage.

OR

Press Archive button in the Archive Pane. You can also archive other videos if you enter their ID there.


## Help

### One of my extract timestamps wiped!?

This can rarely happen if you hold ALT+LEFT or ALT+RIGHT and cycle theough many cards quickly. You may recover the times from the title of the card.

### Server errors

Restart the server and report the error on issues.

### SecurityError

If you get a security error, you may need to increase the number of allowed connections in your browser. Link to a SO post for IE on how to do this for WebSockets: https://stackoverflow.com/a/56889101


### I'm not sure how to use this...

1. Download the zip off github, you'll have a SupermemoScripts zip file. 
2. Unzip it and go into SuperMemoScripts/YoutubeReactExtension. 
3. Copy server/YouTube.htm and paste it in C:/SuperMemo/bin, replacing the existing YouTube.htm. 
4. Go into the server folder in SuperMemoScripts/YoutubeReactExtension.
5. Hold shift key and right click, select the menu option "open in terminal". You might have to select the more options menu for it to appear. 
6. Follow the steps in getting started

### Want to change port

CURRENTLY DISABLED: Update the port variables in SMPlayer.tsx and server.ts. Change port in YouTube.htm.

### Known bugs

- Scrolling elemnts with mouse wheel or keyboard in element browser may wipe YT extracts 

### Differences with vanilla supermemo

- Extract background colour is lost (blue)
- Clicking fields inserts current time

## Version History

* 0.1
    * Mark/Stop/Start buttons work
    * Loading YouTube videos
    * Loads SM scripts locally
* 0.2
    * Nonblocking player and hotkeys
    * Playback speed slider
* 0.3
    * Bypass MEMLEAK in supermemo
    * Load external IE window with YT player
    * Changes reflect back to SM
    * Extracts and navigation work
    * Start, Stop, Mark textbox can be clicked to set times
    * Everything in the UI works
* 1.0 
    * App completely rewritten to react
    * Server caches players so videos load quicker
* 1.1
    * Server can locally archive and load videos
    * Offline mode for watching archived videos
    * More robust to errors

### Roadmap
* Add Archive component which lets send a video to be archived

## License

See LICENSE

## Acknowledgments

* [SuperMemo yt.htm](https://www.super-memory.com/)
