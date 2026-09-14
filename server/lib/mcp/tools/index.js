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
 * The note tools are shared with Trace; see tools/notes.js for the tiers.
 */
import { registerNoteReadTools, registerNoteWriteTools, registerNoteDestroyTools } from './notes.js';

export function registerReadTools(server, ctx) {
  registerNoteReadTools(server, ctx);
}

export function registerWriteTools(server, ctx) {
  registerNoteWriteTools(server, ctx);
}

export function registerDestroyTools(server, ctx) {
  registerNoteDestroyTools(server, ctx);
}
