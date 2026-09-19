/**
 * label-icons.js: the icons a label can wear in the sidebar. Material Symbols
 * names, grouped roughly by theme. Pure; shared by the server and the app.
 */
export const LABEL_ICONS = [
  'home', 'work', 'school', 'family_restroom', 'favorite', 'pets',
  'shopping_cart', 'restaurant', 'kitchen', 'local_cafe', 'cake', 'celebration',
  'fitness_center', 'self_improvement', 'medical_services', 'spa', 'directions_run', 'sports_esports',
  'flight', 'luggage', 'directions_car', 'park', 'yard', 'handyman',
  'savings', 'receipt_long', 'account_balance', 'event', 'schedule', 'inventory_2',
  'lightbulb', 'psychology', 'science', 'code', 'dns', 'terminal',
  'menu_book', 'movie', 'music_note', 'photo_camera', 'palette', 'brush',
  'star', 'bolt', 'rocket_launch', 'eco', 'public', 'lock',
];

/** A known icon name, or null. */
export function cleanLabelIcon(v) {
  const s = String(v ?? '').trim();
  return LABEL_ICONS.includes(s) ? s : null;
}
