

import { contextBridge, ipcRenderer } from 'electron';
const listeners = new Set<(command: string) => void>();
const beforeClose = new Set<() => Promise<void>>();
let markCloseReady: () => void;
const closeReady = new Promise<void>((resolve) => { markCloseReady = resolve; });

const editable = (el: Element | null) =>
  !!el && (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'range', 'file'].includes(el.type))
    || (el as HTMLElement).isContentEditable);

ipcRenderer.on('orca-desktop:menu', (_e, command: string) => {

  if ((command === 'undo' || command === 'redo') && editable(document.activeElement)) {
    document.execCommand(command);
    return;
  }
  window.dispatchEvent(new CustomEvent('orca-desktop-menu', { detail: command }));
  for (const cb of listeners) cb(command);
});

contextBridge.exposeInMainWorld('orcaDesktop', {
  version: 1,
  platform: process.platform,
  spaceMouse: process.platform === 'win32',
  onSpaceMouse(cb: (bytes: number[]) => void) {
    const handler = (_event: unknown, bytes: number[]) => cb(bytes);
    ipcRenderer.on('orca-desktop:spacemouse', handler);
    return () => { ipcRenderer.removeListener('orca-desktop:spacemouse', handler); };
  },
  onSpaceMouseStatus(cb: (status: 'listening' | 'error' | 'off' | 'starting') => void) {
    const handler = (_event: unknown, status: 'listening' | 'error' | 'off' | 'starting') => cb(status);
    ipcRenderer.on('orca-desktop:spacemouse-status', handler);
    return () => { ipcRenderer.removeListener('orca-desktop:spacemouse-status', handler); };
  },
  spaceMouseStatus: (): Promise<'listening' | 'error' | 'off' | 'starting'> => ipcRenderer.invoke('orca-desktop:spacemouse-status'),


  bambuConnect: (jobId: string, filename: string): Promise<void> => ipcRenderer.invoke('orca-desktop:bambu-connect', jobId, filename),
  onBeforeClose(handler: () => Promise<void>) {
    beforeClose.add(handler);
    markCloseReady();
    return () => { beforeClose.delete(handler); };
  },
  async flushBeforeClose() {

    await closeReady;
    await Promise.all([...beforeClose].map((handler) => handler()));
  },
  onMenu(cb: (command: string) => void) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
});
