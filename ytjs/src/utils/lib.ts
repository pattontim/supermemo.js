// const { execSync } = require('child_process');
// const os = require('os');
import { exec, execSync } from 'child_process';
import os from 'os';

export function commandExistsSync(command: string) {
  const isWindows = os.platform() === 'win32';
  const cmd = isWindows ? 'where' : 'which';

  try {
    execSync(`${cmd} ${command}`, { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

export function getCommandOutput(command: string, ...args: string[]): Promise<string> {
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
