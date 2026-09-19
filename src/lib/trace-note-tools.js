/**
 * trace-note-tools.js: Trace's note tools, run through NoteApi.
 * The catalog and logic are shared with MCP in server/lib/note-tools.js.
 */
import { NoteApi } from './api.js';
import { NOTE_TOOLS, executeNoteTool as run } from '../../server/lib/note-tools.js';

export { NOTE_TOOLS };

export function executeNoteTool(name, args) {
  return run(name, args, NoteApi);
}
