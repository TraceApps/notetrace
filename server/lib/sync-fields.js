/**
 * The fields of each synced table, as two edits of a row meet them
 * (lib/field-sync.js): the newer edit of each field stays. The server keeps
 * when each last changed (field_times, db.js); the Android app keeps the
 * copy the server has of each row and says which of these it changed
 * (src/lib/db-native.js, src/lib/sync.js). Columns a push writes another
 * way (a row's note or label, a checklist item's uuid) aren't here.
 */
export const SYNC_FIELDS = {
  notes: [
    'title', 'body_md', 'kind', 'color', 'pinned', 'archived', 'in_tasks',
    'trashed_at', 'reminder_at', 'reminder_rrule', 'reminder_tz', 'read_only',
  ],
  labels: ['name', 'color', 'icon', 'position'],
  checklist_items: ['text', 'checked', 'checked_at', 'position', 'due_date', 'due_repeat'],
  note_attachments: [
    'url', 'mime', 'name', 'size_bytes', 'preview_url', 'drawing', 'width', 'height',
    'duration_ms', 'waveform', 'position', 'extracted_text', 'segments', 'summary',
  ],
  // A label on a note is there or not (deleted_at): nothing else to merge.
  note_labels: [],
};

/**
 * Fields that mean something only together, merged as one: the edit that
 * stays brings the whole group.
 */
export const SYNC_GROUPS = {
  notes: [
    // A list turned into text (or back) moves its content between the
    // text and the items: a text from before the change doesn't fit after.
    ['body_md', 'kind'],
    // When, how often and in which time zone: one reminder.
    ['reminder_at', 'reminder_rrule', 'reminder_tz'],
  ],
  // When an item was ticked belongs to its tick; a repeat to its due date.
  checklist_items: [['checked', 'checked_at'], ['due_date', 'due_repeat']],
  note_attachments: [
    // The file and what describes it: a drawing redrawn is a new picture,
    // its size and preview with it.
    ['url', 'mime', 'name', 'size_bytes', 'preview_url', 'drawing', 'width', 'height', 'duration_ms', 'waveform'],
    // A voice note's transcript and its timed pieces.
    ['extracted_text', 'segments'],
  ],
};

/** Fields that hold JSON (as text here): compared by what they hold. A
 *  drawing's strokes, a voice note's waveform and timed transcript. */
export const SYNC_JSON = {
  note_attachments: ['drawing', 'waveform', 'segments'],
};
