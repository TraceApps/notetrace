/**
 * MCP tool registrar. Called once per request when the McpServer is
 * built. Each tool is registered against the user identified by
 * ctx.userId: the token that hit the MCP endpoint owns the scope of
 * every query, and every DB query in a tool must filter by user_id.
 *
 * Write tools are registered ONLY when the request context reports
 * writes: true, which requires BOTH the server-side MCP_WRITE_ENABLED
 * flag AND the caller's token holding the `mcp:write` scope. Destroy
 * tools require BOTH MCP_DESTROY_ENABLED AND `mcp:destroy`. If either
 * half of a gate is absent the corresponding tools don't appear in
 * tools/list at all.
 *
 * Note tools (search_notes, get_note, create_note, append_to_note,
 * add_checklist_item, check_checklist_item, list_reminders) arrive
 * with the notes data layer.
 */

// eslint-disable-next-line no-unused-vars
export function registerReadTools(server, ctx) {}

// eslint-disable-next-line no-unused-vars
export function registerWriteTools(server, ctx) {}

// eslint-disable-next-line no-unused-vars
export function registerDestroyTools(server, ctx) {}
