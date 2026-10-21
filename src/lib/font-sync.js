import { DB } from './db.js';

export const FONT_SETTING_KEYS = new Set(['fontTheme', 'fontSize']);

// The scope itself stays on this device, per account/server. A fresh
// browser follows the account unless its user opts out here.
export function isLocalFontSetting(key) {
  return key === 'fontSyncScope'
    || (FONT_SETTING_KEYS.has(key) && DB.getSetting('fontSyncScope', 'account') === 'device');
}
