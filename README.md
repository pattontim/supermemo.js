
# SuperMemo.js

SuperMemo extract extension engine. Allows user to load different types of React components directly in supermemo. See supported components.

## Supported Components [to be expanded]

### YouTube

- Fixes SuperMemo memleaks and slowdowns in video elements
- Modern react-player is used to extend the functionality of incremental video in SM-18
- Completely extensible with more features
- Archive and load saved videos
- See and copy subtitles!
- And more!

![Screenshot](main-screen.png)

## Foreword

I now consider this a beta and usable, it won't overwrite your cards under expected operation. However, I recommend that you [backup your collection](https://www.supermemo.wiki/en/supermemo/backup-guide) before starting to use this extension.

## Getting Started

### Dependencies

* SuperMemo 18
* Windows 
* NodeJS (install CLI tools if you don't have it already)
* npm

### Quick start

* backup YouTube.htm in your install SuperMemo/bin folder (Usually C:/SuperMemo/bin)

* copy YouTube.htm from this folder over C:/SuperMemo/bin/YouTube.htm, overwriting it

* run `npm install` in supermemo.js root folder

* cd to ytjs folder: `cd yts`

* run `npm install` again to install deps for the ytjs server

* cd to root folder: `cd ..`

* run `npm run build` to build the react app that SuperMemo will load

* run `npm run ytjs` to start the video server

* import a YT video in supermemo using CTRL+N

* from now on you will need to run `npm run ytjs` whenever you want to load videos in SM. Restore the backup you made to go back to regular behaviour. 


## Building the react app

Run `npm run build` in the root folder

## How it works

We are capable of loading videos from youtube more quickly. The server does this by running a server with a cached [youtubei.js Innertube](https://github.com/LuanRT/YouTube.js) player and serving the MPD to the player for streaming.

SuperMemo loads a YouTube.htm when video components are loaded. We redirect it to load our own react app directly in SM. Therefore the code is totally extensible. Also, we can hijack the way SM stores YouTube video IDs to store more than just YouTube videos. These IDs are normally only 11 characters. In theory we can store up to 32 characters, which is the limit set by SM. In this data we can store links to other files. Other component types will use this novel technique to extend SuperMemo in an open source way. 

## Using youtube video archive feature

You can archive videos and they'll be loaded instead of from youtube. To do this, in your browser go to http://localhost:3000/archive/<youtube_id_here>/ and wait until you get an OK message. From that point on, the video will be loaded from file storage.

OR

[RECOMMENDED!!! Press Archive button in the Archive Pane. You can also archive other videos if you enter their ID there.


## Help

### One of my extract timestamps wiped!?

This can rarely happen if you hold ALT+LEFT or ALT+RIGHT and cycle theough many cards quickly. You may recover the times from the title of the card.

### Server errors

Restart the server and report the error on issues.

### I'm not sure how to use this...

1. Download the zip off github. 
1. Unzip it and go into the unzipped folder. 
1. Copy YouTube.htm and paste it in C:/SuperMemo/bin, replacing the existing YouTube.htm.  
1. Go back to the unzipped folder. [WINDOWS] Hold shift key and right click, select the menu option "open in terminal". You might have to select the more options menu for it to appear. 
1. Run all the commands in Getting Started

### Want to change port

CURRENTLY DISABLED: Update the port variables in SMPlayer.tsx and server.ts. Change port in YouTube.htm.

### Known bugs

- Scrolling elemnts with mouse wheel or keyboard in element browser may wipe YT extracts 

- Pressing ctrl+v while the video player is focused and with a YT video in your clipboard overwrites the current YT extract. This may be a SM feature however.

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
- Archive quality selector
- Settings page: subtitle settings, auto archive videos, etc.

## License

See LICENSE

## Acknowledgments

* [SuperMemo yt.htm](https://www.super-memory.com/)

## The coffee pledge

This is a project I started in early 2022 to keep SuperMemo competitive with vendors who promise to lock incremental features behind paywalls. For each donation received, I will take a serendipitous visit to my local coffee shop and work on the app for the duration of the visit.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/A0A2N1AXM)
