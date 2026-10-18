<script>
  import Toggle from './Toggle.svelte';
  import { _ } from 'svelte-i18n';
  import { aiEnabled, aiProvider, aiApiKey, aiModel, aiBaseUrl, aiTokenLimits, aiAssistantName, aiKeyVerified, smartLogEnabled, smartLogVoiceLang, autoTranscribe, autoSummarizeLong, autoReadImages, aiTranscribeModel, envLocks as envLocksStore } from '../../stores/settings.js';
  import { AI_PROVIDERS, AI_DEFAULT_MODELS, AI_MODELS, AI_MODEL_LABELS, AI_MODEL_CUSTOM, renamedModel, callAI, callAIProxy } from '../../lib/aiChat.js';
  import { showError, showSuccess } from '../../stores/toast.js';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import TraceTokenLimits from './TraceTokenLimits.svelte';

  // Subscribe to the global envLocks store (populated by App.svelte at
  // startup). Same envLocks shape across the apps. Mirrors NutriTrace #36.
  export let envLocks = { ai: false, ai_enabled: false };
  $: envLocks = $envLocksStore;
  // When env-locked, the toggle's displayed state comes from AI_ENABLED env
  // var, not the per-user store (which stays empty under env-lock because
  // user_settings doesn't pick up server-wide env values).
  $: _displayedAiEnabled = envLocks.ai ? !!envLocks.ai_enabled : $aiEnabled;
  // The server names its OpenAI-compatible provider oai-compat, which isn't
  // one of the picker's ids, so a locked install showed an empty box.
  const SERVER_PROVIDER_IDS = { 'oai-compat': 'custom' };
  const providerId = (id) => SERVER_PROVIDER_IDS[id] || id || '';
  const providerLabel = (id) =>
    AI_PROVIDERS.find(p => p.id === providerId(id))?.label || id || '';
  $: lockedProvider = envLocks.ai ? providerId(envLocks.ai_provider) : '';

  // Smart Log voice-input language options, the same list as NutriTrace.
  const VOICE_LANG_CODES = ['auto', 'en-US', 'en-GB', 'it-IT', 'es-ES', 'es-MX', 'fr-FR', 'de-DE', 'pt-BR', 'pt-PT',
    'nl-NL', 'pl-PL', 'ru-RU', 'sv-SE', 'da-DK', 'nb-NO', 'fi-FI', 'cs-CZ', 'tr-TR', 'ja-JP', 'ko-KR', 'zh-CN', 'zh-TW', 'hi-IN', 'ar-SA'];
  $: VOICE_LANGS = VOICE_LANG_CODES.map(value => ({ value, label: $_(`settings_trace_ct.voice_langs.${value.replace('-', '_')}`) }));

  let showKey = false;
  let testing = false;
  let testStatus = '';   // '' | 'ok' | 'fail'

  // Drafts for fields that have explicit Save buttons. Matching the
  // NutriTrace pattern: paste / type freely, then click Save to commit.
  // The draft is initialised from the store and re-synced when the
  // store changes (e.g. settings sync from another device).
  //
  // Sync via a guarded reactive that only fires when the STORE value
  // actually changes. The previous `$: draft = $store || draft` form
  // reran on every keystroke (because `draft` is one of its
  // dependencies) and silently overwrote the user's typing once a
  // value had been saved before, surfacing as "field is read-only"
  // for any user trying to update their key or base URL. (Issue #5.)
  let aiApiKeyDraft  = $aiApiKey  || '';
  let aiBaseUrlDraft = $aiBaseUrl || '';
  let aiKeySaved     = false;
  let aiBaseUrlSaved = false;
  let _aiApiKeySynced  = $aiApiKey;
  let _aiBaseUrlSynced = $aiBaseUrl;
  $: if ($aiApiKey !== _aiApiKeySynced) {
    _aiApiKeySynced = $aiApiKey;
    aiApiKeyDraft = $aiApiKey || '';
  }
  $: if ($aiBaseUrl !== _aiBaseUrlSynced) {
    _aiBaseUrlSynced = $aiBaseUrl;
    aiBaseUrlDraft = $aiBaseUrl || '';
  }

  // Saving a field also runs the connection test (see _autoTest). If it
  // succeeds the user gets a toast + green check + the Trace FAB unlocks.
  // If it fails the toast tells them why and aiKeyVerified stays off. Test
  // Connection runs it again at any time.
  // Saved when the field is left, as in NutriTrace; unchanged values don't re-test.
  async function saveAiKey() {
    if (aiApiKeyDraft === ($aiApiKey || '')) return;
    aiApiKey.set(aiApiKeyDraft);
    await _autoTest();
  }
  async function saveAiBaseUrl() {
    const next = aiBaseUrlDraft.trim();
    if (next === ($aiBaseUrl || '')) return;
    aiBaseUrl.set(next);
    await _autoTest();
  }
  // A saved field tests once everything it needs is filled in, whichever
  // field comes last (the model, with no key). Until then it waits quietly;
  // Test says what's missing. An OpenAI-compatible server is tried before
  // its key (the field below) is in, as it may need none: a failure then
  // shows in the banner only, rather than a pop-up about a key still coming.
  async function _autoTest() {
    if (!_canTest()) return;
    const keyMayFollow = $aiProvider === 'custom' && !$aiApiKey?.trim();
    await testConnection({ silentOk: false, quietFail: keyMayFollow });
  }

  $: providerModels = AI_MODELS[$aiProvider] || [];

  // Escape hatch: branded providers' preset list includes an AI_MODEL_CUSTOM
  // sentinel. When the select shows the sentinel, a free-text input appears
  // so users can enter a model ID we haven't hardcoded (e.g. after a vendor
  // renames). $aiModel remains the source of truth persisted to the store.
  let aiModelSelectVal;
  let aiCustomModelVal = '';
  {
    // A model saved under a name that has since changed shows (and is kept)
    // under its new name. Not for OpenAI Compatible: its names are the
    // server's own.
    if ($aiProvider !== 'custom' && $aiModel && renamedModel($aiModel) !== $aiModel) {
      aiModel.set(renamedModel($aiModel));
    }
    const saved = $aiModel;
    const _pm = AI_MODELS[$aiProvider] || [];
    const isPreset = _pm.includes(saved) && saved !== AI_MODEL_CUSTOM;
    if (saved && !isPreset && $aiProvider !== 'custom') {
      aiModelSelectVal = AI_MODEL_CUSTOM;
      aiCustomModelVal = saved;
    } else {
      aiModelSelectVal = saved || AI_DEFAULT_MODELS[$aiProvider] || '';
    }
  }

  function _syncModelFromSelect() {
    if ($aiProvider === 'custom') return;
    const next = (aiModelSelectVal === AI_MODEL_CUSTOM)
      ? aiCustomModelVal.trim()
      : (aiModelSelectVal || '');
    aiModel.set(next);
    _invalidate();
  }
  function _modelLabel(m) {
    return m === AI_MODEL_CUSTOM ? 'Custom…' : (AI_MODEL_LABELS[m] || m);
  }
  // Required fields the user must fill in for a meaningful test. A function,
  // not a $: value: a field saved on blur tests at once, before a reactive
  // value would have caught up with what was just saved, so the last field
  // filled in always read as missing (TraceApps/notetrace#18). An
  // OpenAI-compatible server may need no key (Ollama, LM Studio), as in chat.
  // A cloud provider with no model saved uses the one its list shows (its
  // default), as chat does, so the key alone is enough there.
  const _canTest = () => !envLocks.ai && ($aiProvider === 'custom'
    ? !!$aiBaseUrl?.trim() && !!$aiModel?.trim()
    : !!$aiApiKey?.trim());

  // Any change to the auth fields invalidates the prior test result.
  // Clears aiKeyVerified so the FAB hides until the user retests.
  function _invalidate() {
    if ($aiKeyVerified) aiKeyVerified.set(false);
    testStatus = '';
  }

  // When the provider changes and the current model isn't valid for it,
  // snap to the provider's default. (User can still edit freely.)
  function onProviderChange(e) {
    const next = e.target.value;
    aiProvider.set(next);
    const valid = AI_MODELS[next] || [];
    if (next !== 'custom' && !valid.includes($aiModel)) {
      aiModel.set(AI_DEFAULT_MODELS[next] || '');
    }
    // Sync escape-hatch state so the select reflects the new provider
    if (next !== 'custom') {
      const saved = $aiModel;
      const isPreset = (AI_MODELS[next] || []).includes(saved) && saved !== AI_MODEL_CUSTOM;
      if (saved && !isPreset) {
        aiModelSelectVal = AI_MODEL_CUSTOM;
        aiCustomModelVal = saved;
      } else {
        aiModelSelectVal = saved;
        aiCustomModelVal = '';
      }
    }
    // Not tested here: the key saved is the old provider's, and would go to
    // the new one (or to a saved OpenAI-compatible address) before its own
    // is in. Saving a field, or Test, tests.
    _invalidate();
  }

  // What a test was run with. A result only counts for the settings it
  // tested: a field changed while it ran makes it stale, and it goes. What
  // changed it tests on its own once saved (a field left, a model picked),
  // waiting its turn; a provider switch doesn't, so the old provider's key
  // isn't sent to the new one.
  const _testedKey = () => JSON.stringify([envLocks.ai, $aiProvider, $aiApiKey, $aiModel, $aiBaseUrl]);
  let _testAgain = null;
  let testError = '';

  async function testConnection({ silentOk = false, quietFail = false } = {}) {
    if (testing) {
      // A test someone asked for outranks a quiet automatic one.
      _testAgain = { silentOk, quietFail: quietFail && (_testAgain?.quietFail ?? true) };
      return;
    }
    if (!_canTest() && !envLocks.ai) {
      showError($_($aiProvider === 'custom' ? 'settings_trace_ct.toast.fill_fields_custom' : 'settings_trace_ct.toast.fill_fields'));
      return;
    }
    testing = true;
    testStatus = '';
    testError = '';
    const tested = _testedKey();
    const stale = () => {
      if (_testedKey() === tested) return false;
      return true;
    };
    try {
      // The test must mirror how the rest of the app actually calls AI:
      //  - env-locked installs hit the server proxy (key on the server)
      //  - everyone else calls the provider DIRECTLY from the client
      //    using the GUI-entered key (matches aiChat.js callAI path)
      // The previous version always hit /api/ai/chat which 503'd with
      // "AI not configured on server" whenever AI_API_KEY env var wasn't
      // set, even though the user had pasted a working key in the form.
      const messages = [{ role: 'user', content: 'Say "hi" in one word.' }];
      const systemPrompt = 'You are a test bot. Reply with exactly one short word.';
      let text;
      if (envLocks.ai) {
        text = await callAIProxy({ messages, systemPrompt, tokenLimits: $aiTokenLimits });
      } else {
        text = await callAI({
          provider:  $aiProvider,
          apiKey:    $aiApiKey,
          model:     $aiModel,
          baseUrl:   $aiBaseUrl,
          tokenLimits: $aiTokenLimits,
          messages,
          systemPrompt,
        });
      }
      if (!text || typeof text !== 'string') {
        throw new Error('Empty response from AI');
      }
      if (stale()) return;
      testStatus = 'ok';
      aiKeyVerified.set(true);
      if (!silentOk) showSuccess($_('settings_trace_ct.toast.connected'));
    } catch (e) {
      if (stale()) return;
      testStatus = 'fail';
      testError = e.message || 'Test failed';
      aiKeyVerified.set(false);
      if (!quietFail) showError(testError);
    } finally {
      testing = false;
      if (_testAgain) {
        const again = _testAgain;
        _testAgain = null;
        if (_canTest() || envLocks.ai) testConnection(again);
      }
    }
  }
</script>

{#if envLocks.ai}
  <div class="env-lock-banner">
    <span class="material-symbols-rounded">lock</span>
    {$_('settings_trace_ct.env_lock_banner')}
  </div>
{/if}
<div class="card settings-card">
  {#if _displayedAiEnabled}
    {@const _provider = AI_PROVIDERS.find(p => p.id === $aiProvider)}
    {@const _label = envLocks.ai ? 'Environment-locked' :
      (_provider ? _provider.label : ($aiProvider || ''))}
    <ConnectionStatus
      status={testing ? 'testing' : ($aiKeyVerified || testStatus === 'ok' || (envLocks.ai && envLocks.ai_enabled) ? 'ok' : (testStatus === 'fail' ? 'fail' : ''))}
      connectedAs={_label}
      error={testStatus === 'fail' ? testError : ''}
    />
  {/if}
  <div class="setting-row">
    <div>
      <span class="setting-label">{$_('settings_trace_ct.enable_assistant')}</span>
      <span class="setting-desc">{envLocks.ai
        ? $_('settings_trace_ct.enable_desc_locked')
        : $_('settings_trace_ct.enable_desc')}</span>
    </div>
    <Toggle label={$_('settings_trace_ct.enable_assistant')} checked={_displayedAiEnabled} disabled={envLocks.ai} on:change={e => { if (!envLocks.ai) aiEnabled.set(e.detail); }} />
  </div>

  {#if _displayedAiEnabled}
    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings_trace_ct.provider')}</span>
      {#if envLocks.ai}
        <div class="select-wrap expand-left" style="width:220px">
          <select aria-label={$_('settings_trace_ct.provider')} class="select sel-sm" value={lockedProvider} disabled>
            <option value={lockedProvider}>{providerLabel(envLocks.ai_provider)}</option>
          </select>
        </div>
      {:else}
      <div class="select-wrap expand-left" style="width:220px">
        <select class="select sel-sm" value={$aiProvider} on:change={onProviderChange}>
          {#each AI_PROVIDERS as p}
            <option value={p.id}>{p.label}</option>
          {/each}
        </select>
      </div>
      {/if}
    </div>

    {#if $aiProvider === 'custom'}
      <div class="setting-divider"></div>
      <div class="setting-row stack">
        <span class="setting-label">{$_('settings_trace_ct.base_url')} <span class="setting-desc">{$_('settings_trace_ct.base_url_desc')}</span></span>
        <div class="key-row">
          <input class="input" type="url" bind:value={aiBaseUrlDraft}
            placeholder="https://api.example.com"
            aria-label={$_('settings_trace_ct.base_url')}
            on:input={_invalidate} on:blur={saveAiBaseUrl}
            on:keydown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        </div>
      </div>
    {/if}

    <div class="setting-divider"></div>
    <div class="setting-row">
      <span class="setting-label">{$_('settings_trace_ct.model')}</span>
      {#if envLocks.ai}
        <div class="select-wrap" style="width:220px">
          <select aria-label={$_('settings_trace_ct.model')} class="select sel-sm" value="locked" disabled>
            <option value="locked">{envLocks.ai_model ? _modelLabel(envLocks.ai_model) : $_('settings_trace_ct.server_default')}</option>
          </select>
        </div>
      {:else if providerModels.length > 0 && $aiProvider !== 'custom'}
        <div class="select-wrap" style="width:220px">
          <select class="select sel-sm" bind:value={aiModelSelectVal} on:change={() => { _syncModelFromSelect(); _autoTest(); }}>
            {#each providerModels as m}<option value={m}>{_modelLabel(m)}</option>{/each}
          </select>
        </div>
      {:else}
        <input class="input" type="text" style="width:220px" value={$aiModel}
          placeholder={AI_DEFAULT_MODELS[$aiProvider] || ''}
          on:change={e => { aiModel.set(e.target.value); _invalidate(); _autoTest(); }} />
      {/if}
    </div>
    {#if aiModelSelectVal === AI_MODEL_CUSTOM && $aiProvider !== 'custom'}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <span class="setting-label">{$_('settings_trace_ct.custom_model_id')}</span>
        <input aria-label={$_('settings_trace_ct.custom_model_id')} class="input" type="text" style="width:220px"
          placeholder={$aiProvider === 'gemini' ? 'gemini-3.5-flash' : $aiProvider === 'claude' ? 'claude-sonnet-5' : 'gpt-4o'}
          bind:value={aiCustomModelVal} on:input={_syncModelFromSelect} on:change={_autoTest} />
      </div>
      <div style="padding:8px 16px 12px;display:flex;gap:8px;align-items:flex-start">
        <span class="material-symbols-rounded" style="font-size:16px;color:var(--muted);flex-shrink:0;margin-top:2px">info</span>
        <div class="setting-desc" style="margin:0;line-height:1.5">
          Enter the exact model ID from the vendor (e.g.
          {#if $aiProvider === 'gemini'}<a href="https://ai.google.dev/gemini-api/docs/models" target="_blank" rel="noopener" class="about-link">Google's model list</a>
          {:else if $aiProvider === 'claude'}<a href="https://docs.anthropic.com/en/docs/about-claude/models/overview" target="_blank" rel="noopener" class="about-link">Anthropic's model list</a>
          {:else}<a href="https://platform.openai.com/docs/models" target="_blank" rel="noopener" class="about-link">OpenAI's model list</a>{/if}). Use this if the preset dropdown doesn't have the model you want.
        </div>
      </div>
    {/if}

    {#if !envLocks.ai}
    <div class="setting-divider"></div>
    <div class="setting-row stack">
      <span class="setting-label">API Key</span>
      <div class="key-row">
        {#if showKey}
          <input aria-label="API Key" class="input" type="text"
            bind:value={aiApiKeyDraft}
            placeholder="sk-…"
            on:input={_invalidate} on:blur={saveAiKey}
            on:keydown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        {:else}
          <input aria-label="API Key" class="input" type="password"
            bind:value={aiApiKeyDraft}
            placeholder="sk-…"
            on:input={_invalidate} on:blur={saveAiKey}
            on:keydown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        {/if}
        <button class="key-toggle" on:click={() => showKey = !showKey}
          aria-label={showKey ? 'Hide' : 'Show'}>
          <span class="material-symbols-rounded">{showKey ? 'visibility_off' : 'visibility'}</span>
        </button>
      </div>
    </div>
    {/if}

    {#if (envLocks.ai ? lockedProvider : $aiProvider) === 'custom'}
      <TraceTokenLimits />
    {/if}

    <!-- Always here, not only in the status banner, which shows nothing
         before the first test or after a change (TraceApps/notetrace#18). -->
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_trace_ct.test_connection')}</span>
        <span class="setting-desc">{$_(envLocks.ai ? 'settings_trace_ct.test_connection_desc_locked' : 'settings_trace_ct.test_connection_desc')}</span>
      </div>
      <button type="button" class="btn btn-secondary" on:click={() => testConnection()} disabled={testing}>
        {testing ? $_('settings_trace_ct.testing') : $_('settings_trace_ct.test')}
      </button>
    </div>

    <div class="setting-divider"></div>
    <div class="setting-row stack">
      <span class="setting-label">{$_('settings_trace_ct.assistant_name')}</span>
      <input aria-label={$_('settings_trace_ct.assistant_name')} class="input" type="text" value={$aiAssistantName} placeholder={$_('settings_trace_ct.assistant_name_ph')}
        on:change={e => aiAssistantName.set(e.target.value || 'Trace')} />
    </div>


    <!-- Smart Log: hold the FAB, dictate, and the AI tidies the text
         into a note. Off by default; tap-to-dictate still works
         either way. -->
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('settings_trace_ct.smart_log')}</span>
        <span class="setting-desc">
          Hold the Trace button, speak a thought, and let Trace clean it up into a short note.
        </span>
      </div>
      <Toggle label={$_('settings_trace_ct.smart_log')} checked={$smartLogEnabled} on:change={e => smartLogEnabled.set(e.detail)} />
    </div>
    {#if $smartLogEnabled}
      <div class="setting-divider"></div>
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('settings_trace_ct.voice_lang')}</span>
          <span class="setting-desc">{$_('settings_trace_ct.voice_lang_desc')}</span>
        </div>
        <div class="select-wrap expand-left" style="width:220px">
          <select aria-label={$_('settings_trace_ct.voice_lang')} class="select sel-sm" value={$smartLogVoiceLang}
            on:change={e => smartLogVoiceLang.set(e.currentTarget.value)}>
            {#each VOICE_LANGS as opt}<option value={opt.value}>{opt.label}</option>{/each}
          </select>
        </div>
      </div>
    {/if}

    <!-- Voice notes and images -->
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('trace_extract.auto_transcribe')}</span>
        <span class="setting-desc">{$_('trace_extract.auto_transcribe_desc')}</span>
      </div>
      <Toggle label={$_('trace_extract.auto_transcribe')} checked={$autoTranscribe} on:change={e => autoTranscribe.set(e.detail)} />
    </div>
    {#if $autoTranscribe}
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('trace_extract.auto_summarize')}</span>
          <span class="setting-desc">{$_('trace_extract.auto_summarize_desc')}</span>
        </div>
        <Toggle label={$_('trace_extract.auto_summarize')} checked={$autoSummarizeLong} on:change={e => autoSummarizeLong.set(e.detail)} />
      </div>
    {/if}
    {#if $aiProvider === 'custom' || $aiProvider === 'openai'}
      <div class="setting-row">
        <div>
          <span class="setting-label">{$_('trace_extract.transcribe_model')}</span>
          <span class="setting-desc">{$_('trace_extract.transcribe_model_desc')}</span>
        </div>
        <input aria-label={$_('trace_extract.transcribe_model')} class="input model-input" type="text" spellcheck="false" autocapitalize="none"
          placeholder={$aiProvider === 'openai' ? 'gpt-4o-mini-transcribe' : 'whisper-1'}
          value={$aiTranscribeModel} on:change={e => aiTranscribeModel.set(e.target.value.trim())} />
      </div>
    {/if}
    <div class="setting-divider"></div>
    <div class="setting-row">
      <div>
        <span class="setting-label">{$_('trace_extract.auto_read_images')}</span>
        <span class="setting-desc">{$_('trace_extract.auto_read_images_desc')}</span>
      </div>
      <Toggle label={$_('trace_extract.auto_read_images')} checked={$autoReadImages} on:change={e => autoReadImages.set(e.detail)} />
    </div>

    <!-- Status row — Save runs the test on each click, so this is a
         The connection status banner at the top of this card is the
         single source of truth for AI connection state — Re-test lives
         there. No separate row needed. -->
  {/if}
</div>

<style>
  .card.settings-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .setting-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
  }
  .setting-row.stack { flex-direction: column; align-items: stretch; gap: 8px; }
  .setting-row > div:first-child { flex: 1; min-width: 0; }
  .setting-label { font-size: 14px; color: var(--text-1); display: block; }
  .setting-desc { font-size: 12px; color: var(--text-3); margin-top: 4px; line-height: 1.4; display: block; }
  .setting-divider { height: 1px; background: var(--border); margin: 0 16px; }

  .input {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 9px 12px;
    color: var(--text-1);
    font-size: 14px;
    font-family: inherit;
    box-sizing: border-box;
    width: 100%;
  }
  .input:focus { outline: 2px solid var(--accent-dim); border-color: var(--accent); }
  .input:disabled { opacity: 0.6; cursor: not-allowed; }

  /* Keep all three children (input, eye-toggle, save) at the same
     height + vertically centered — the row was previously stretching
     the input and locking save to 40px which produced a 1–2px misalign. */
  .key-row { display: flex; gap: 6px; align-items: center; }
  .key-row > * { height: 40px; box-sizing: border-box; }
  .key-row .input { flex: 1; font-family: monospace; }
  .model-input { width: 200px; max-width: 45%; }
  .key-toggle {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); width: 40px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; color: var(--text-3);
  }
  .key-toggle:hover:not(:disabled) { color: var(--text-1); }
  .key-toggle:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Same banner the other Trace apps show above an environment-locked section. */
  .env-lock-banner {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 10px; padding: 10px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    font-size: 13px; color: var(--text-3);
  }
  .env-lock-banner .material-symbols-rounded { font-size: 17px; color: var(--accent); flex-shrink: 0; }

  /* expand-left: anchor the native dropdown to the right edge so it
     opens leftward instead of rightward. Useful when the select sits
     on the right side of a narrow panel and the longest option might
     otherwise spill past the panel. Pure CSS using direction:rtl on
     the select; option text is forced back to LTR + left-aligned so
     content reads normally. */
  .select-wrap.expand-left .select {
    direction: rtl;
    text-align: left;
  }
  .select-wrap.expand-left .select option {
    direction: ltr;
    text-align: left;
  }

</style>
