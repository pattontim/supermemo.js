// const { execSync } = require('child_process');
// const os = require('os');
import { exec, execSync } from 'child_process';
import os from 'os';

export async function commandExists(command: string): Promise<boolean> {
  const isWindows = os.platform() === 'win32';
  const cmd = isWindows ? 'where' : 'which';

  return new Promise((resolve) => {
    exec(`${cmd} ${command}`, (error) => {
      resolve(!error);
    });
  });
}

export async function getCommandOutput(command: string, skipExistCheck: boolean = false, ...args: string[]): Promise<string | null> {
  if (!skipExistCheck) {
    const exists = await commandExists(command);
    if (!exists) {
      return null;
    }
  }

  return new Promise((resolve, reject) => {
    exec(`${command} ${args.join(' ')}`, (error, stdout, stderr) => {
      if (error) {
        reject(stderr);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

export function deepCopy<T>(obj: T): T {
  const objStr = JSON.stringify(obj);

  if (objStr === undefined || objStr === null) {
    return obj;
  }

  return JSON.parse(objStr);
}
	// function getYtdlpVersion(){
	// 	return new Promise((resolve, reject) => {
	// 		return commandExists('yt-dlp').then((exists) => {
	// 			if(exists){
	// 				return getCommandOutput('yt-dlp', ...['--version']).then((version) => {
	// 					resolve(version);
	// 				});
	// 			} else {
	// 				resolve(null);
	// 			}
	// 		});
	// 	})
	// }
