interface HidCollection { usagePage: number; usage: number; children?: HidCollection[] }
interface HidReport { reportId: number; data: DataView }
interface HidDevice {
  productId: number;
  opened: boolean;
  collections: HidCollection[];
  open(): Promise<void>;
  addEventListener(type: 'inputreport', listener: (event: HidReport) => void): void;
}
interface HidApi {
  getDevices(): Promise<HidDevice[]>;
  requestDevice(options: { filters: { vendorId: number; productId?: number }[] }): Promise<HidDevice[]>;
  addEventListener(type: 'connect' | 'disconnect', listener: (event: { device: HidDevice }) => void): void;
}

function browserHid(): HidApi | null {
  const hid = (navigator as Navigator & { hid?: HidApi }).hid;
  return hid ?? null;
}

const PRODUCTS = [
  0xc603, 0xc605, 0xc606, 0xc621, 0xc623, 0xc625, 0xc626, 0xc627, 0xc628, 0xc629, 0xc62b,
  0xc640, 0xc62e, 0xc62f, 0xc631, 0xc632, 0xc633, 0xc635, 0xc636, 0xc63a, 0xc652,
];

export interface SpaceSample {
  translation: [number, number, number] | null;
  rotation: [number, number, number] | null;
  button: number | null;
}

export interface SpaceTarget {
  isActive(): boolean;
  controls: { enabled: boolean };
  applySpace(sample: SpaceSample): void;
}

export type SpaceMouseState = 'desktop' | 'connected' | 'idle' | 'unsupported' | 'busy';

const views = new Set<SpaceTarget>();
const listeners = new Set<() => void>();
const opened = new Set<HidDevice>();
let state: SpaceMouseState = 'idle';
let installed = false;
let buttons = 0;

export const spaceMouseSnapshot = () => state;
export const subscribeSpaceMouse = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function setState(next: SpaceMouseState) {
  if (state === next) return;
  state = next;
  listeners.forEach((listener) => listener());
}

function axis(packet: Uint8Array, offset: number): number {
  const value = packet[offset] | (packet[offset + 1] << 8);
  return (value >= 32768 ? value - 65536 : value) / 350;
}

function vector(packet: Uint8Array, offset: number, signs: [number, number, number]): [number, number, number] {
  return [signs[0] * axis(packet, offset), signs[1] * axis(packet, offset + 2), signs[2] * axis(packet, offset + 4)];
}

export function parseSpaceReport(packet: Uint8Array): { translation: [number, number, number] | null; rotation: [number, number, number] | null; buttons: number | null } | null {
  const id = packet[0];
  if (id === 1 && packet.length >= 7) {
    return {
      translation: vector(packet, 1, [-1, 1, 1]),
      rotation: packet.length >= 13 ? vector(packet, 7, [1, 1, 1]) : null,
      buttons: null,
    };
  }
  if (id === 2 && packet.length >= 7) return { translation: null, rotation: vector(packet, 1, [1, 1, 1]), buttons: null };
  if (id !== 3 || packet.length < 2) return null;
  let mask = 0;
  for (let i = 1; i < packet.length && i <= 4; i++) mask |= packet[i] << (8 * (i - 1));
  return { translation: null, rotation: null, buttons: mask };
}

function moving(value: [number, number, number] | null) {
  return !!value && (value[0] !== 0 || value[1] !== 0 || value[2] !== 0);
}

function deliver(packet: Uint8Array) {
  const report = parseSpaceReport(packet);
  if (!report) return;
  let button: number | null = null;
  if (report.buttons !== null) {
    const pressed = report.buttons & ~buttons;
    buttons = report.buttons;
    if (pressed) for (let i = 0; i < 32; i++) if (pressed & (1 << i)) { button = i; break; }
  }
  if (!moving(report.translation) && !moving(report.rotation) && button === null) return;
  const sample = { translation: report.translation, rotation: report.rotation, button };
  for (const view of views) if (view.isActive() && view.controls.enabled) view.applySpace(sample);
}

function packetFromReport(reportId: number, data: DataView): Uint8Array {
  const payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (reportId === 0) return payload;
  const packet = new Uint8Array(payload.length + 1);
  packet[0] = reportId;
  packet.set(payload, 1);
  return packet;
}

function usable(device: HidDevice) {
  const visit = (collection: HidCollection): boolean =>
    collection.usagePage === 0x01 && collection.usage === 0x08 || (collection.children ?? []).some(visit);
  return device.collections.some(visit) || PRODUCTS.includes(device.productId);
}

async function openDevice(device: HidDevice): Promise<boolean> {
  if (!usable(device)) return false;
  if (opened.has(device)) return true;
  opened.add(device);
  try {
    if (!device.opened) await device.open();
    device.addEventListener('inputreport', (event) => deliver(packetFromReport(event.reportId, event.data)));
    return true;
  } catch (error) {
    opened.delete(device);
    throw error;
  }
}

function filters() {
  return [{ vendorId: 0x256f }, ...PRODUCTS.map((productId) => ({ vendorId: 0x046d, productId }))];
}

async function reopenGranted() {
  const hid = browserHid();
  if (!hid) return;
  let connected = false;
  for (const device of await hid.getDevices()) {
    try { connected = await openDevice(device) || connected; } catch { /* try the next interface */ }
  }
  if (connected) setState('connected');
}

function desktopFailed() {
  setState(browserHid() ? 'idle' : 'unsupported');
  void reopenGranted();
}

export function installSpaceMouse() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const desktop = window.orcaDesktop;
  if (desktop?.spaceMouse) {
    setState('desktop');
    desktop.onSpaceMouse?.(deliverBytes);
    desktop.onSpaceMouseStatus?.((next) => { if (next === 'error') desktopFailed(); });
    void desktop.spaceMouseStatus?.().then((next) => { if (next === 'error') desktopFailed(); });
    return;
  }
  const hid = browserHid();
  if (!hid) {
    setState('unsupported');
    return;
  }
  setState('idle');
  hid.addEventListener('connect', (event) => { void openDevice(event.device).then((ok) => { if (ok) setState('connected'); }).catch(() => {}); });
  hid.addEventListener('disconnect', (event) => {
    opened.delete(event.device);
    if (opened.size === 0 && state === 'connected') setState('idle');
  });
  void reopenGranted();
}

function deliverBytes(bytes: number[]) {
  deliver(Uint8Array.from(bytes));
}

export async function connectSpaceMouse() {
  installSpaceMouse();
  const hid = browserHid();
  if (!hid) {
    setState('unsupported');
    return;
  }
  setState('busy');
  try {
    const devices = await hid.requestDevice({ filters: filters() });
    let connected = false;
    for (const device of devices) connected = await openDevice(device) || connected;
    setState(connected ? 'connected' : 'idle');
  } catch {
    setState('idle');
  }
}

export function attachSpaceMouse(view: SpaceTarget) {
  views.add(view);
  installSpaceMouse();
  return () => views.delete(view);
}
