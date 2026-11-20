/**
 * The settings an admin can give everyone a default for (from
 * nutritrace#326), with the values NoteTrace offers for each and the
 * environment variable that sets and locks it. Settings > Regional reads
 * these too. Kept in server/lib because the server image has no src/.
 */
export const REGIONAL_OPTIONS = {
  language:   { env: 'DEFAULT_LANGUAGE',    values: ['en'] },
  dateFormat: { env: 'DEFAULT_DATE_FORMAT', values: ['ISO', 'US', 'EU', 'natural'] },
  timeFormat: { env: 'DEFAULT_TIME_FORMAT', values: ['12h', '24h'] },
};
