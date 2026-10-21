// @capacitor/* for scripts/auth-start.test.js: the web app, or the phone
// when AUTH_PHONE=1. Nothing here does anything.
const phone = process.env.AUTH_PHONE === '1';
const inert = new Proxy({}, { get: (_, k) => (k === 'then' ? undefined : async () => ({})) });
export const Capacitor = { isNativePlatform: () => phone, convertFileSrc: x => x, getPlatform: () => (phone ? 'android' : 'web') };
export const CapacitorHttp = inert, CapacitorCookies = inert, Preferences = inert, BiometricAuth = inert, Browser = inert, Filesystem = inert, CapacitorSQLite = inert;
export const App = { addListener() {} }, Network = { getStatus: async () => ({ connected: true }) }, Directory = { Data: 'DATA', Cache: 'CACHE' };
export const registerPlugin = () => inert;
export class SQLiteConnection { async checkConnectionsConsistency() { return { result: false }; } async isConnection() { return { result: false }; } async createConnection() { throw new Error('no SQLite here'); } }
export default {};
