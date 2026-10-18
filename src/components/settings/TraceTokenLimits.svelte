<script>
  import { _ } from 'svelte-i18n';
  import { aiTokenLimits } from '../../stores/settings.js';
  import { normalizeTokenLimits, TOKEN_LIMIT_MAX } from '../../lib/ai-token-limits.js';

  let synced = $aiTokenLimits;
  let maxTokens = synced?.maxTokens ?? 16384;
  let contextSize = synced?.contextSize || 0;
  let error = '';
  let saved = false;
  $: if ($aiTokenLimits !== synced) {
    synced = $aiTokenLimits;
    maxTokens = synced?.maxTokens ?? 16384;
    contextSize = synced?.contextSize || 0;
    saved = false;
    error = '';
  }

  function changed() { error = ''; saved = false; }
  function save() {
    try {
      const value = normalizeTokenLimits({ maxTokens, contextSize });
      synced = value;
      aiTokenLimits.set(value);
      saved = true;
    } catch {
      error = $_('trace_tokens.errors.invalid');
    }
  }
</script>

<div class="setting-divider"></div>
<div class="setting-row stack">
  <label class="setting-label" for="trace-max-output">{$_('trace_tokens.max_output')}</label>
  <span class="setting-desc" id="trace-max-output-desc">{$_('trace_tokens.max_output_desc')}</span>
  <input id="trace-max-output" class="input" type="number" min="1" max={TOKEN_LIMIT_MAX} step="1"
    aria-describedby="trace-max-output-desc" bind:value={maxTokens} on:input={changed} />
  <label class="setting-label" for="trace-context">{$_('trace_tokens.context')}</label>
  <span class="setting-desc" id="trace-context-desc">{$_('trace_tokens.context_desc')}</span>
  <input id="trace-context" class="input" type="number" min="0" max={TOKEN_LIMIT_MAX} step="1"
    aria-describedby="trace-context-desc" bind:value={contextSize} on:input={changed} />
  {#if error}<p class="token-error" role="alert">{error}</p>{/if}
  <button type="button" class="btn btn-secondary" on:click={save}>{$_('trace_tokens.save')}</button>
  {#if saved}<span class="setting-desc" role="status">{$_('trace_tokens.saved')}</span>{/if}
</div>

<style>
  .token-error { color: var(--danger); font-size: 13px; }
</style>
