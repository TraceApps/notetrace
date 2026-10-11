// The Capacitor plugins the app's sync and sign-in code touch. The cookie
// jar and CapacitorHttp are the phone stand-in of native-cookies.test.js.
export { CapacitorHttp, CapacitorCookies, Capacitor } from '../native-cookies/capacitor.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
export const Filesystem = { readdir: async () => ({ files: [] }), stat: async () => { throw new Error('none'); }, readFile: async () => { throw new Error('none'); }, writeFile: async () => ({ uri: '' }), mkdir: async () => ({}), deleteFile: async () => ({}), getUri: async () => ({ uri: '' }) };
export const Directory = { Data: 'DATA', Cache: 'CACHE', Documents: 'DOCUMENTS' };
export const Network = { getStatus: async () => ({ connected: true, connectionType: 'wifi' }), addListener: async () => ({ remove() {} }) };
// InstallMarkerPlugin: a file a backup never copies (PHONE_DB.marker).
const markerFile = () => (process.env.PHONE_DB ? process.env.PHONE_DB + '.marker' : null);
let _marker = null;
const InstallMarker = {
  async get() { const f = markerFile(); if (f) { try { return { value: readFileSync(f, 'utf8') || null }; } catch { return { value: null }; } } return { value: _marker }; },
  async set({ value }) { const f = markerFile(); if (f) writeFileSync(f, String(value)); else _marker = value; },
};
const inert = new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : async () => ({})) });
// The home screen widget: what it was last sent (globalThis.__widget).
const NoteWidget = { async update(snapshot) { (globalThis.__widget ??= []).push(snapshot); return {}; } };
// The reminder alarms: every list handed to the native scheduler, which
// arms exactly the last one (globalThis.__reminders).
const NoteReminders = new Proxy({
  async reschedule({ reminders }) { (globalThis.__reminders ??= []).push((reminders || []).map(r => r.title).sort()); return { armed: (reminders || []).length, exact: true }; },
}, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
export const registerPlugin = name => (name === 'InstallMarker' ? InstallMarker : name === 'NoteWidget' ? NoteWidget : name === 'NoteReminders' ? NoteReminders : inert);
export const App = { addListener: async () => ({ remove() {} }) };
export const Preferences = inert, BiometricAuth = inert, Browser = inert, LocalNotifications = inert, Haptics = inert, Share = inert;
export default {};
