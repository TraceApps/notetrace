/**
 * Static-analysis tests for the MCP endpoint wiring.
 *
 * These do not exercise the wire protocol; they only guard against
 * accidental unwiring of the route mount, the scope registration, or
 * the tool registrations during future refactors. End-to-end protocol
 * verification is done by running the server with MCP_ENABLED=1 and
 * pointing a real MCP client at it (docs/notetrace/mcp.md covers setup).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexJs   = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const mcpRoute  = readFileSync(new URL('../server/routes/mcp.js', import.meta.url), 'utf8');
const mcpServer = readFileSync(new URL('../server/lib/mcp/server.js', import.meta.url), 'utf8');
const mcpTools  = readFileSync(new URL('../server/lib/mcp/tools/index.js', import.meta.url), 'utf8');
const apiTokens = readFileSync(new URL('../server/lib/api-tokens.js', import.meta.url), 'utf8');
const pkgJson   = JSON.parse(readFileSync(new URL('../server/package.json', import.meta.url), 'utf8'));

test('MCP route is mounted at /api/mcp on the main router', () => {
  assert.match(indexJs, /import mcpRoutes[\s\S]*from '\.\/routes\/mcp\.js'/);
  assert.match(indexJs, /router\.use\('\/api\/mcp',\s*mcpRoutes\)/);
});

test('API tokens admin route is mounted at /api/admin/api-tokens', () => {
  assert.match(indexJs, /import apiTokensRoutes[\s\S]*from '\.\/routes\/api-tokens\.js'/);
  assert.match(indexJs, /router\.use\('\/api\/admin\/api-tokens',\s*apiTokensRoutes\)/);
});

test('MCP route is feature-flagged on MCP_ENABLED and requires bearer + at-least-one mcp:* scope', () => {
  assert.match(mcpRoute, /MCP_ENABLED/);
  assert.match(mcpRoute, /bearerAuth/);
  // Any-of-mcp:* check: route-level gate accepts read, write, OR destroy
  // (so a write-only or destroy-only token isn't unusable). Per-tool
  // scope enforcement happens at registration time.
  assert.match(mcpRoute, /requireAnyMcpScope/);
  assert.match(mcpRoute, /'mcp:read'/);
  assert.match(mcpRoute, /'mcp:write'/);
  assert.match(mcpRoute, /'mcp:destroy'/);
});

test('MCP route validates Origin as a DNS-rebinding defense', () => {
  assert.match(mcpRoute, /_isOriginAllowed|Origin not allowed|origin_rejected/);
});

test('mcp:read scope is registered in KNOWN_SCOPES so tokens can hold it', () => {
  assert.match(apiTokens, /'mcp:read'/);
});

test('mcp:write scope is registered', () => {
  assert.match(apiTokens, /'mcp:write'/);
});

test('mcp:destroy scope is registered', () => {
  assert.match(apiTokens, /'mcp:destroy'/);
});

test('every KNOWN_SCOPES entry has a matching SCOPE_DESCRIPTIONS entry and vice versa', () => {
  // Locate each block by its declaration, not by the first textual
  // mention of the name — both blocks' own doc-comments reference the
  // other by name, so a naive indexOf(name) lands mid-comment.
  const descBlock  = apiTokens.slice(
    apiTokens.indexOf('SCOPE_DESCRIPTIONS = {'),
    apiTokens.indexOf('};', apiTokens.indexOf('SCOPE_DESCRIPTIONS = {'))
  );
  const knownBlock = apiTokens.slice(
    apiTokens.indexOf('KNOWN_SCOPES = new Set(['),
    apiTokens.indexOf(']);', apiTokens.indexOf('KNOWN_SCOPES = new Set(['))
  );
  const descScopes  = new Set([...descBlock.matchAll(/'([a-z]+:[a-z]+)':/g)].map(m => m[1]));
  const knownScopes = new Set([...knownBlock.matchAll(/'([a-z]+:[a-z]+)'/g)].map(m => m[1]));
  assert.ok(descScopes.size > 0, 'no scopes found in SCOPE_DESCRIPTIONS — block boundaries may be wrong');
  assert.ok(knownScopes.size > 0, 'no scopes found in KNOWN_SCOPES — block boundaries may be wrong');
  for (const s of knownScopes) {
    assert.ok(descScopes.has(s), `${s} is in KNOWN_SCOPES but missing from SCOPE_DESCRIPTIONS`);
  }
  for (const s of descScopes) {
    assert.ok(knownScopes.has(s), `${s} is in SCOPE_DESCRIPTIONS but missing from KNOWN_SCOPES`);
  }
});

test('MCP route computes write eligibility from MCP_WRITE_ENABLED + mcp:write scope', () => {
  assert.match(mcpRoute, /MCP_WRITE_ENABLED/);
  assert.match(mcpRoute, /mcp:write/);
  assert.match(mcpRoute, /req\.mcpWrites/);
});

test('MCP route computes destroy eligibility from MCP_DESTROY_ENABLED + mcp:destroy scope', () => {
  assert.match(mcpRoute, /MCP_DESTROY_ENABLED/);
  assert.match(mcpRoute, /mcp:destroy/);
  assert.match(mcpRoute, /req\.mcpDestroy/);
});

test('MCP server registers write tools only when req.mcpWrites is true', () => {
  assert.match(mcpServer, /registerWriteTools/);
  assert.match(mcpServer, /req\.mcpWrites/);
});

test('MCP server registers destroy tools only when req.mcpDestroy is true', () => {
  assert.match(mcpServer, /registerDestroyTools/);
  assert.match(mcpServer, /req\.mcpDestroy/);
});

test('MCP transport is stateless (no session id generator)', () => {
  assert.match(mcpServer, /sessionIdGenerator:\s*undefined/);
});

test('tools/index.js exports the read, write, and destroy registrars the server calls', () => {
  for (const fn of ['registerReadTools', 'registerWriteTools', 'registerDestroyTools']) {
    assert.match(mcpTools, new RegExp(`export function ${fn}\\(`), `expected ${fn} export in tools/index.js`);
    assert.match(mcpServer, new RegExp(`\\b${fn}\\(`), `expected server.js to call ${fn}()`);
  }
});

test('@modelcontextprotocol/sdk and zod are declared as runtime dependencies', () => {
  const deps = pkgJson.dependencies || {};
  assert.ok(deps['@modelcontextprotocol/sdk'], 'missing @modelcontextprotocol/sdk in dependencies');
  assert.ok(deps['zod'], 'missing zod (SDK peer + used for tool inputSchema) in dependencies');
});
