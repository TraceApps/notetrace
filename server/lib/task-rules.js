/**
 * task-rules.js: which checklist items count as tasks. Pure; shared by the
 * Tasks view, Trace, and MCP.
 *
 * An open item is a task when it has a due date, or when its checklist is set
 * to Show in Tasks (in_tasks). With the "Show Every Checklist in Tasks"
 * setting, every open item is one.
 */
export function isTask(note, item, { allChecklists = false } = {}) {
  if (!note || note.kind !== 'checklist' || !item || item.checked) return false;
  if (!String(item.text || '').trim()) return false;
  return allChecklists || !!item.due_date || !!note.in_tasks;
}

/** The checklist the Tasks view's Add a Task box writes to. */
export function isTasksInbox(note, inboxTitle = 'Tasks') {
  return note?.kind === 'checklist' && String(note.title || '').trim().toLowerCase() === String(inboxTitle).toLowerCase();
}
