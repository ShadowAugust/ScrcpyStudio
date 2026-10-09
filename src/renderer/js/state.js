// Global app state + tiny event bus.
import { BUILTIN_PROFILES } from './options.js';

export const api = window.api;

export const state = {
  devices: [],
  devicesError: null,
  selected: null,
  sessions: [],
  config: null,
  info: null,
  view: 'devices',
  queryCache: {},   // serial -> { videoEncoders, audioEncoders, displays, cameras, cameraSizes, apps }
};

const listeners = new Map();
export const bus = {
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt).delete(fn);
  },
  emit(evt, data) {
    for (const fn of listeners.get(evt) || []) {
      try { fn(data); } catch (e) { console.error(`listener for ${evt} failed`, e); }
    }
  },
};

export async function saveConfig(patch) {
  state.config = await api.store.set(patch);
  bus.emit('config', state.config);
  return state.config;
}
export const saveSettings = (patch) => saveConfig({ settings: patch });
export const settings = () => state.config.settings;

// ------------------------------------------------------------------ devices
export function deviceName(d) {
  if (!d) return '';
  return state.config?.deviceAliases?.[d.serial] || d.deviceName || d.marketName || d.model || d.serial;
}

export function deviceSubtitle(d) {
  const brand = d.brand ? d.brand.charAt(0).toUpperCase() + d.brand.slice(1) : '';
  const model = d.marketName || d.model || '';
  return [brand && !model.toLowerCase().startsWith(brand.toLowerCase()) ? brand : '', model].filter(Boolean).join(' ') || d.product || 'Android device';
}

export function readyDevices() { return state.devices.filter(d => d.state === 'device'); }

export function selectedDevice() {
  return state.devices.find(d => d.serial === state.selected) || null;
}

export function selectDevice(serial) {
  if (state.selected === serial) return;
  state.selected = serial;
  api.store.set({ selectedSerial: serial });
  bus.emit('selected', selectedDevice());
}

export function sessionsFor(serial) {
  return state.sessions.filter(s => s.serial === serial && !s.endedAt);
}

// ------------------------------------------------------------------ profiles
export function allProfiles() {
  return [...BUILTIN_PROFILES, ...(state.config?.profiles || [])];
}

export function getProfile(id) {
  return allProfiles().find(p => p.id === id) || BUILTIN_PROFILES[0];
}

export function activeProfile() {
  return getProfile(state.config?.activeProfileId);
}

export function profileFor(serial) {
  const id = state.config?.deviceProfiles?.[serial];
  return id ? getProfile(id) : activeProfile();
}
