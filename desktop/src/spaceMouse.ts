import { app, type BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

export type SpaceMouseState = 'off' | 'starting' | 'listening' | 'error';

let state: SpaceMouseState = 'off';
let child: ChildProcess | null = null;
let compiler: ChildProcess | null = null;
let stopped = false;

export const spaceMouseState = () => state;

function sourceFile(): string | null {
  const candidates = [path.join(__dirname, '..', 'src', 'spaceMouseRaw.cs'), path.join(__dirname, 'spaceMouseRaw.cs')];
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

function publish(getWindow: () => BrowserWindow | null, next: SpaceMouseState) {
  state = next;
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send('orca-desktop:spacemouse-status', next);
}

function forward(getWindow: () => BrowserWindow | null, line: string) {
  if (!/^[0-9A-F]+$/.test(line) || line.length < 2 || line.length % 2 !== 0) return;
  const win = getWindow();
  if (!win || win.isDestroyed() || !win.isFocused()) return;
  const bytes: number[] = [];
  for (let i = 0; i < line.length; i += 2) bytes.push(Number.parseInt(line.slice(i, i + 2), 16));
  win.webContents.send('orca-desktop:spacemouse', bytes);
}

function launch(getWindow: () => BrowserWindow | null, exe: string) {
  if (stopped) return;
  const proc = spawn(exe, [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child = proc;
  let pending = '';
  proc.stdout?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk: string) => {
    pending += chunk;
    let nl = pending.indexOf('\n');
    while (nl >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (line === 'READY') publish(getWindow, 'listening');
      else if (line.startsWith('ERROR')) {
        console.error(`SpaceMouse: ${line}`);
        publish(getWindow, 'error');
      } else forward(getWindow, line);
      nl = pending.indexOf('\n');
    }
  });
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: string) => console.error(`SpaceMouse: ${chunk.trim()}`));
  proc.on('exit', (code) => {
    if (child === proc) child = null;
    if (!stopped && state !== 'error') {
      console.error(`SpaceMouse reader stopped (${code ?? 'unknown'}).`);
      publish(getWindow, 'error');
    }
  });
}

function compile(source: string, exe: string): Promise<boolean> {
  return new Promise((resolve) => {
    const stamp = `${exe}.sha`;
    const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    if (fs.existsSync(exe) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === hash) {
      resolve(true);
      return;
    }
    const proc = spawn(CSC, ['/nologo', '/optimize+', '/target:exe', `/out:${exe}`, source], { windowsHide: true });
    compiler = proc;
    let errors = '';
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => { errors += chunk; });
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => { errors += chunk; });
    proc.on('exit', (code) => {
      if (compiler === proc) compiler = null;
      if (code === 0 && fs.existsSync(exe)) {
        fs.writeFileSync(stamp, hash);
        resolve(true);
      } else {
        console.error(`SpaceMouse compile failed (${code ?? 'unknown'}). ${errors.trim()}`);
        resolve(false);
      }
    });
    proc.on('error', (error) => {
      console.error(`SpaceMouse compile failed. ${error.message}`);
      resolve(false);
    });
  });
}

export async function startSpaceMouse(getWindow: () => BrowserWindow | null) {
  if (process.platform !== 'win32') return;
  stopped = false;
  state = 'starting';
  const source = sourceFile();
  if (!source || !fs.existsSync(CSC)) {
    console.error('SpaceMouse reader is unavailable on this computer.');
    publish(getWindow, 'error');
    return;
  }
  const exe = path.join(app.getPath('userData'), 'SpaceMouseRaw.exe');
  const built = await compile(source, exe);
  if (stopped) return;
  if (!built) {
    publish(getWindow, 'error');
    return;
  }
  launch(getWindow, exe);
}

export function stopSpaceMouse() {
  stopped = true;
  compiler?.kill();
  compiler = null;
  child?.kill();
  child = null;
  state = 'off';
}
