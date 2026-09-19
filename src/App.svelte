<script>
  import { viewport, sizeClass, contentWidth } from './stores/window-size.js';
  import { initFold } from './lib/fold.js';
  import { onMount }   from 'svelte';
  import { fade, fly, slide } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { portal } from './lib/portal.js';
  import { handleBack } from './lib/back-stack.js';
  import Router, { location, push } from 'svelte-spa-router';

  import BottomNav from './components/layout/BottomNav.svelte';
  import Sidebar   from './components/layout/Sidebar.svelte';
  import Tasks     from './routes/Tasks.svelte';
  import Shopping  from './routes/Shopping.svelte';
  import UpdateBanner from './components/UpdateBanner.svelte';
  import Toast     from './components/ui/Toast.svelte';
  import ConfirmDialogMount from './components/ui/ConfirmDialogMount.svelte';
  import { DB }    from './lib/db.js';
  import { NoteApi } from './lib/api.js';
  import { navStyle, applyAccentColor, accentColor, applyAppearance, appearance, disableAnimations, sidebarPersistent, sidebarRail, sidebarRailMedium, cardDensity, pageBanners, bannerStyle, bannerAnimation, forceMobileLayout, startPage, language } from './stores/settings.js';
  import { _, locale } from 'svelte-i18n';
  import { currentUser, userMgmtActive, setupRequired, loadAuthState, handleOidcCallback } from './stores/auth.js';
  import { needsNativeSetup, isNative, getNativeMode, getServerUrl, apiUrl } from './lib/platform.js';
  import { writable } from 'svelte/store';
  import { notesChanged, signalNotesChanged } from './stores/notes.js';
  import { notifLocalEnabled, appLockEnabled } from './stores/settings.js';
  import { refreshHomeWidget } from './lib/home-widget.js';
  import { appLocked } from './lib/app-lock.js';
  import LockScreen from './components/LockScreen.svelte';
  import OfflineStatus from './components/OfflineStatus.svelte';
  import { describeConnectionIssue } from './lib/connection-message.js';

  // Sync state — mirrored from the real sync store (dynamically imported).
  // Includes the smart-banner fields (connectionIssue, showErrorBanner) so
  // the banner + red cloud badge below stay reactive to the classifier.
  const syncState = writable({
    syncing: false, phase: '', progress: '', lastSync: null, error: null, online: true,
    connectionIssue: null, showErrorBanner: false,
  });
  $: _syncModeActive = isNative && getNativeMode() === 'server';
  // Server is reachable when we've seen a healthy probe recently AND no
  // structured issue is outstanding. Drives both the red cloud badge and
  // the banner suppression logic — matches NT's exact predicate.
  $: _serverReachable = $syncState.online && !$syncState.connectionIssue;
  // Reactive copy build. Fed by the sync engine's classifier; falls back
  // to the generic "Sync error" title + raw message when a non-connection
  // error is surfaced with showFailureBanner=true.
  $: _connectionCopy = describeConnectionIssue($syncState.connectionIssue, $_, true);
  $: _syncBannerCopy = $syncState.showErrorBanner && _connectionCopy
    ? { ..._connectionCopy, icon: _connectionCopy.tone === 'wait' ? 'cloud_off' : 'cloud_alert' }
    : ($syncState.showErrorBanner && $syncState.error
      ? { title: $_('sync.error_title'), detail: $syncState.error, icon: 'error', tone: 'bad' }
      : null);

  // Pull-to-refresh gesture (native server mode). Mirrors NT App.svelte.
  const PULL_SYNC_SLOP = 10;
  const PULL_SYNC_THRESHOLD = 64;
  const PULL_SYNC_MAX = 88;
  let _pullStartX = 0;
  let _pullStartY = 0;
  let _pullDistance = 0;
  let _pullTracking = false;
  let _pullRefreshing = false;
  let _retryingConnection = false;

  async function _waitForSyncIdle(maxMs = 4000) {
    const start = Date.now();
    return new Promise(resolve => {
      const check = () => {
        let s; syncState.subscribe(v => s = v)();
        if (!s?.syncing || Date.now() - start > maxMs) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
  }

  async function _runForcedSync() {
    try {
      const mod = await import('./lib/sync.js');
      let result = await mod.fullSync(false, true, true);
      if (result?.reason === 'busy') {
        await _waitForSyncIdle();
        result = await mod.fullSync(false, true, true);
      }
      return result;
    } catch (e) {
      console.warn('[sync] forced sync failed:', e?.message);
      return { ok: false };
    }
  }

  async function _retryServerConnection() {
    if (_retryingConnection) return;
    _retryingConnection = true;
    try { await _runForcedSync(); }
    finally { _retryingConnection = false; }
  }

  // Dismiss clears only the full banner surface; connectionIssue stays
  // so the cloud badge + Settings status keep telling the truth about
  // reachability. Dynamic-import reaches the REAL sync store, not the
  // App.svelte mirror — mirrors are one-way.
  async function _dismissSyncBanner() {
    try {
      const mod = await import('./lib/sync.js');
      mod.syncState.update(s => ({ ...s, showErrorBanner: false, error: null }));
    } catch { /* silent */ }
  }

  // Phones and tablets without a sync connection refresh the note list instead.
  const _coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
  $: _pullEnabled = _syncModeActive || _coarse;
  let _pullStartT = 0;
  function _startPullSync(event) {
    if (!_pullEnabled || _pullRefreshing || sidebarOpen || showNativeSetup) return;
    if (event.target?.closest?.('.editor-backdrop, .bulk-bar, .pop-backdrop, .fab, .fab-menu, .fab-scrim')) return;
    if (event.target?.closest?.('[role="dialog"], .sheet-backdrop, .sidebar-panel, .sidebar-backdrop, .bottom-nav')) return;
    // Walk up from the touch target to the nearest scrolling ancestor.
    // Handles both editor pages (their own `.page-shell.editor-page`
    // becomes the scroller because it's position: fixed + overflow-y: auto)
    // AND list pages (scrolling bubbles to `.page-transition`). A single
    // gate covers any future scroll container without needing an allowlist.
    let el = event.target;
    while (el && el !== document.body) {
      const s = getComputedStyle(el);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) {
        if (el.scrollTop > 0) return;
        break;
      }
      el = el.parentElement;
    }
    _pullStartX = event.touches[0].clientX;
    _pullStartY = event.touches[0].clientY;
    _pullStartT = Date.now();
    _pullTracking = true;
    _pullDistance = 0;
  }
  function _movePullSync(event) {
    if (!_pullTracking) return;
    const dx = event.touches[0].clientX - _pullStartX;
    const dy = event.touches[0].clientY - _pullStartY;
    if (Math.abs(dx) > Math.abs(dy)) { _pullTracking = false; _pullDistance = 0; return; }
    if (dy < PULL_SYNC_SLOP) return;
    // A long press is a select or drag, not a pull.
    if ((_pullDistance === 0 && Date.now() - _pullStartT > 450) || document.documentElement.classList.contains('card-dragging')) { _pullTracking = false; _pullDistance = 0; return; }
    event.preventDefault();
    _pullDistance = Math.min(PULL_SYNC_MAX, (dy - PULL_SYNC_SLOP) * 0.5);
  }
  async function _finishPullSync() {
    if (!_pullTracking) return;
    const hit = _pullDistance >= PULL_SYNC_THRESHOLD;
    _pullTracking = false;
    if (!hit) { _pullDistance = 0; return; }
    _pullRefreshing = true;
    // Park the spinner at the threshold while refreshing, like the other Trace apps.
    _pullDistance = PULL_SYNC_THRESHOLD;
    console.info('[sync] pull-to-refresh triggered');
    try {
      if (_syncModeActive) await _runForcedSync();
      else { signalNotesChanged(); await new Promise(r => setTimeout(r, 450)); }
    }
    finally { _pullRefreshing = false; _pullDistance = 0; }
  }
  function _cancelPullSync() { _pullTracking = false; _pullDistance = 0; }

  // Rebuild scheduled reminder notifications after any note change or sync,
  // with notification action labels in the active language.
  $: if (isNative && $notesChanged >= 0) {
    const enabled = $notifLocalEnabled !== false;
    import('./lib/note-reminders.js').then(async ({ configureReminders, rescheduleReminders }) => {
      await configureReminders({
        enabled,
        labels: {
          done: $_('reminders.action_done'),
          snooze: $_('reminders.action_snooze'),
          reminder: $_('reminders.reminder'),
          channel: $_('reminders.channel_name'),
        },
      });
      rescheduleReminders();
    }).catch(() => {});
  }
  // Edits made offline in the browser reached the server: screens reload with the server's copy.
  if (!isNative && typeof window !== 'undefined') {
    window.addEventListener('note:offline-synced', () => { signalNotesChanged(); });
  }
  // The home screen Notes widget follows the notes, and hides them behind App Lock.
  // (changes and user are only there so a change or a sign-in sends a fresh snapshot.)
  $: if (isNative) refreshHomeWidget({ locked: !!$appLockEnabled, changes: $notesChanged, user: $currentUser?.id });

  $: if (!isNative && $_) {
    let label = '';
    try { label = $_('reminders.reminder'); } catch { /* locale still loading */ }
    if (label) import('./lib/web-reminders.js').then(({ setWebReminderLabel }) => setWebReminderLabel(label)).catch(() => {});
  }

  import NativeSetup from './routes/NativeSetup.svelte';

  let showNativeSetup = needsNativeSetup();

  // Eagerly imported (start page).
  import Notes          from './routes/Notes.svelte';
  import Login          from './routes/Login.svelte';
  import Trace      from './components/ai/Trace.svelte';

  // Lazy-loaded routes. svelte-spa-router accepts a `wrap()` async
  // component, so we defer the heavier pages (Settings,
  // Wizard, auth pages) until the user navigates to them. Cuts the
  // start-page bundle by roughly 30%.
  import { wrap } from 'svelte-spa-router/wrap';
  const Settings       = wrap({ asyncComponent: () => import('./routes/Settings.svelte') });
  const Wizard         = wrap({ asyncComponent: () => import('./routes/Wizard.svelte') });
  const Profile        = wrap({ asyncComponent: () => import('./routes/Profile.svelte') });
  const ForgotPassword = wrap({ asyncComponent: () => import('./routes/ForgotPassword.svelte') });
  const ResetPassword  = wrap({ asyncComponent: () => import('./routes/ResetPassword.svelte') });
  const AcceptInvite   = wrap({ asyncComponent: () => import('./routes/AcceptInvite.svelte') });

  const routes = {
    '/':                   Notes,
    '/notes':              Notes,
    '/reminders':          Notes,
    '/archive':            Notes,
    '/trash':              Notes,
    '/label/:id':          Notes,
    '/shared':             Notes,
    '/tasks':              Tasks,
    '/shopping':           Shopping,
    '/settings':           Settings,
    '/settings/:section':  Settings,
    '/wizard':             Wizard,
    '/profile':            Profile,
    '/forgot-password':    ForgotPassword,
    '/reset-password':     ResetPassword,
    '/accept-invite':      AcceptInvite,
    '*':                   Notes,
  };

  // Hide bottom nav + sidebar on full-screen detail/editor pages.
  const NAV_HIDDEN = ['/wizard', '/profile'];
  $: showNav       = !NAV_HIDDEN.some(p => $location.startsWith(p));

  $: _viewportW = $viewport.width;
  // Auto navigation fits the screen: a phone gets the tab bar and the ☰ menu;
  // anything wider pins the sidebar (as icons on a medium screen such as an
  // unfolded foldable) and drops the tab bar. Bottom, Side Panel, and Both
  // behave as they always have.
  $: _auto = $navStyle === 'auto';
  $: _persistentAllowed = _auto ? $sizeClass !== 'compact' : _viewportW >= 768;
  $: railStore = _auto && $sizeClass === 'medium' ? sidebarRailMedium : sidebarRail;

  $: _hasSidebar   = showNav && ($navStyle === 'sidebar' || $navStyle === 'both' || _auto);
  $: sidebarPinned = _hasSidebar && _persistentAllowed && $sidebarPersistent;
  $: hasBottomNav  = showNav && ($navStyle === 'bottom' || $navStyle === 'both' || (_auto && !sidebarPinned));
  $: _sidebarPx = sidebarPinned ? ($railStore ? 76 : 280) : 0;
  $: contentWidth.set(_viewportW - _sidebarPx);
  $: if (typeof document !== 'undefined') {
    const root = document.documentElement;
    for (const c of ['compact', 'medium', 'expanded']) root.classList.toggle(`size-${c}`, $sizeClass === c);
    // Room for two panes (Settings, the List layout) beside whatever sidebar is pinned.
    root.classList.toggle('wide-content', !$forceMobileLayout && _viewportW - _sidebarPx >= 720);
  }
  $: document.documentElement.style.setProperty('--tabbar-h', hasBottomNav ? 'var(--nav-h)' : '0px');
  $: showHamburger = _hasSidebar && !sidebarPinned;

  // --page-top: just the device safe area (hamburger floats over banner)
  // --hamburger-offset: aligns h1 left edge with hamburger button left edge
  //   (used by the banner-on layout where the title sits BELOW the button)
  // --hamburger-row: extra header top-padding so title sits below hamburger
  //   (banner-on only — compact / no-banner layout drops this)
  // --hamburger-clearance: button RIGHT edge + small gap, used by the
  //   compact (banner-off) layout where the title sits BESIDE the button
  //   and needs padding-left to clear the button itself.
  // --sidebar-w: shifts content right when sidebar is persistent
  $: if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--page-top', 'var(--safe-top)');
    document.documentElement.style.setProperty(
      '--hamburger-offset',
      showHamburger ? '12px' : '0px'
    );
    // --hamburger-row only adds a vertical row of padding when the
    // banner-on layout is active (title sits BELOW the floating
    // hamburger). In banner-off / compact mode the title sits NEXT to
    // the button so no extra row is needed.
    // All three banner modes share the compact-header geometry
    // (illustrated SVG banners were retired). --hamburger-row stays 0.
    document.documentElement.style.setProperty('--hamburger-row', '0px');
    // 12px (left margin) + 40px (button width) + 12px (gap before title)
    document.documentElement.style.setProperty(
      '--hamburger-clearance',
      showHamburger ? '64px' : '0px'
    );
    document.documentElement.style.setProperty(
      '--sidebar-w',
      `${_sidebarPx}px`
    );
  }

  let sidebarOpen = false;

  let _prevPinned = false;
  function _syncSidebarToPin(pinned) {
    if (pinned) {
      sidebarOpen = true;
    } else if (_prevPinned) {
      sidebarOpen = false;
    }
    _prevPinned = pinned;
  }
  $: _syncSidebarToPin(sidebarPinned);

  $: if (!_hasSidebar) sidebarOpen = false;

  // svelte-i18n follows the saved language setting.
  $: if ($language) locale.set($language);
  $: applyAccentColor($accentColor);
  $: applyAppearance($appearance);

  // Force-mobile layout: gates every desktop @media rule via the
  // :global(html:not(.force-mobile-layout)) prefix in Settings. When
  // on, wide viewports still get the mobile pattern (single-column
  // drill-in settings, no rail).
  $: if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('force-mobile-layout', !!$forceMobileLayout);
  }

  $: if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('no-animations', !!$disableAnimations);
    document.documentElement.classList.toggle('density-compact', $cardDensity === 'compact');
    // Apply exactly one `banner-animation-<style>` class on documentElement
    // so the CSS animation rules in base.css can target a single decorative
    // style without conflicting selectors. Only active when bannerStyle is
    // 'animated'; gradient + off get no animation class regardless.
    for (const cls of ['banner-animation-shimmer','banner-animation-drift','banner-animation-pulse','banner-animation-aurora']) {
      document.documentElement.classList.remove(cls);
    }
    if ($bannerStyle === 'animated') {
      document.documentElement.classList.add(`banner-animation-${$bannerAnimation || 'shimmer'}`);
    }
  }

  onMount(async () => {
    initFold();
    import('./lib/pending-voice.js').then(m => m.startPendingVoice()).catch(() => {});
    // Start Page: only when the app opens on the default route, never over a
    // deep link, a share, or a notification tap.
    if (['', '#', '#/'].includes(window.location.hash) && ['/reminders', '/tasks', '/archive'].includes($startPage)) {
      import('svelte-spa-router').then(({ replace }) => replace($startPage)).catch(() => {});
    }

    // Local-mode scheduled backup tick — JS-side scheduler that fires
    // exportLocalZip() when due. No-ops in PWA / server modes. See
    // src/lib/local-backup-scheduler.js for design notes.
    if (isNative && getNativeMode() === 'local') {
      import('./lib/local-backup-scheduler.js').then(({ startLocalBackupScheduler }) => {
        startLocalBackupScheduler();
      }).catch(e => console.warn('[local-backup] scheduler start failed:', e?.message));
    }

    if (isNative) {
      // Update-notification tap listener: registered at boot so a
      // shade-notification tap that cold-starts the app still routes
      // to Settings → Updates for the install action.
      import('./lib/notifications.js').then(({ registerUpdateTapListener }) => {
        registerUpdateTapListener(() => {
          import('svelte-spa-router').then(({ push }) => push('/settings/updates'));
        });
      }).catch(() => { /* ignore */ });

      // Clean stale APKs from Directory.Data/updates/ on boot.
      import('./lib/updates.js').then(({ cleanUpdateCache }) => {
        cleanUpdateCache();
      }).catch(() => { /* ignore */ });

      // Optional biometric app lock.
      import('./lib/app-lock.js').then(({ startAppLock }) => startAppLock()).catch(() => {});

      // Share sheet: text and links shared from other apps open a new note.
      import('./lib/share-intent.js').then(({ startShareIntake }) => {
        startShareIntake(() => {
          import('svelte-spa-router').then(({ push }) => push('/'));
        });
      }).catch(() => { /* ignore */ });

      // Note reminders: route notification taps to the note and keep the
      // scheduled set in step with the notes.
      import('./lib/note-reminders.js').then(({ registerReminderActions, rescheduleReminders }) => {
        registerReminderActions(
          (id) => (Number(id) < 0 ? push('/tasks') : push(`/?note=${id}`)),
          () => signalNotesChanged(),
        );
        rescheduleReminders();
        window.addEventListener('note:tasks-digest-changed', () => rescheduleReminders());
      }).catch(() => { /* ignore */ });
    } else {
      // Browser reminders while a NoteTrace tab is open.
      import('./lib/web-reminders.js').then(({ startWebReminders }) => startWebReminders()).catch(() => {});

      // PWA: register the service worker via virtual:pwa-register so we
      // get onNeedRefresh callbacks. Without this, registerType:'prompt'
      // downloads new bundles but never tells the app they're ready.
      import('./lib/pwa-update.js').then(({ registerPwaSw }) => registerPwaSw()).catch(() => {});
    }

    // Visibility-change trigger for BOTH update channels. A user who
    // leaves the tab open for hours / a laptop that resumes from sleep
    // gets a re-check the moment the tab regains focus — respecting the
    // per-user cadence setting (Settings → Updates). The GitHub-tag
    // check returns cached inside the cadence window; the PWA SW-file
    // check just forces the browser to compare sw.js against what it
    // registered (otherwise the browser only bothers every 24h).
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        import('./lib/updates.js').then(({ checkForUpdate, getAutoCheck }) => {
          if (!getAutoCheck()) return;
          checkForUpdate({ force: false }).catch(() => {});
        }).catch(() => {});
        if (!isNative) {
          import('./lib/pwa-update.js').then(({ checkForPwaUpdate }) => checkForPwaUpdate()).catch(() => {});
        }
      });
    }

    // Periodic PWA-bundle poll on the same cadence as the GitHub-tag
    // check, so a tab that stays open all day still surfaces a fresh
    // deploy without a full reload. Cadence honors the same
    // updateCheckInterval setting; 0 (manual) disables the poll.
    if (!isNative && typeof window !== 'undefined') {
      Promise.all([
        import('./lib/pwa-update.js'),
        import('./stores/settings.js'),
      ]).then(([{ checkForPwaUpdate }, { updateCheckInterval }]) => {
        let _pwaPollTimer = null;
        const _resetPoll = (hours) => {
          if (_pwaPollTimer) clearInterval(_pwaPollTimer);
          _pwaPollTimer = null;
          const h = Number(hours) || 0;
          if (!h) return; // manual only
          _pwaPollTimer = setInterval(checkForPwaUpdate, h * 60 * 60 * 1000);
        };
        updateCheckInterval.subscribe(_resetPoll);
      }).catch(() => {});
    }

    if (isNative) {

      import('@capacitor/app').then(({ App }) => {
        let lastBack = 0;
        App.addListener('backButton', ({ canGoBack }) => {
          // A full-screen layer (a drawing, a file) closes before the page goes back.
          if (handleBack()) return;
          if (canGoBack) {
            window.history.back();
          } else {
            const now = Date.now();
            if (now - lastBack < 2000) {
              App.exitApp();
            } else {
              lastBack = now;
              import('./stores/toast.js').then(({ showSuccess }) => {
                showSuccess('Tap again to exit');
              });
            }
          }
        });
        // Leaving the app: the widget gets edits made since the last change signal.
        App.addListener('appStateChange', ({ isActive }) => {
          if (!isActive) refreshHomeWidget({ locked: !!$appLockEnabled, now: true });
          // Coming back is a good moment to top up the watch's token, and it
          // catches a watch paired after this app was last opened.
          else import('./lib/wear-pairing.js').then(({ pairWatch }) => pairWatch()).catch(() => {});
        });
        // And on launch, once auth has settled.
        setTimeout(() => import('./lib/wear-pairing.js').then(({ pairWatch }) => pairWatch()).catch(() => {}), 2500);
        // Deep link callbacks: notetrace://oidc-callback?token=…
        // A home screen shortcut that cold-starts the app arrives as the launch URL.
        App.getLaunchUrl?.().then((r) => {
          const m = String(r?.url || '').match(/^notetrace:\/\/new\/(\w+)/);
          if (m) import('svelte-spa-router').then(({ push }) => push(`/?new=${m[1]}`));
        }).catch(() => {});
        App.addListener('appUrlOpen', async ({ url }) => {
          console.log('[app] deep link received:', url);
          try {
            const u = new URL(url);
            const params = u.searchParams;
            const host = (u.hostname || u.host || '').toLowerCase();
            if (host === 'new') {
              const what = (u.pathname || '').replace(/^\/+/, '') || 'text';
              import('svelte-spa-router').then(({ push }) => push(`/?new=${encodeURIComponent(what)}`));
              return;
            }
            if (host === 'oidc-callback') {
              const errMsg = params.get('error');
              const linked = params.get('linked');
              const token = params.get('token');
              const idTokenHint = params.get('id_token_hint');
              const providerId  = params.get('provider_id');
              if (errMsg) {
                import('./stores/toast.js').then(({ showError }) => showError(decodeURIComponent(errMsg)));
              } else if (linked) {
                import('./stores/toast.js').then(({ showSuccess }) => showSuccess('Linked'));
                await loadAuthState();
              } else if (token) {
                const { setAuthToken } = await import('./lib/platform.js');
                setAuthToken(token);
                // Stash the OIDC session hint so logout() can ask the IdP
                // to end the session via RP-initiated logout. PWA stores
                // this in an httpOnly cookie at the same point; native
                // can't reach that jar so we keep the equivalent here.
                if (idTokenHint && providerId) {
                  try {
                    localStorage.setItem('note:oidc_logout_hint', JSON.stringify({
                      providerId,
                      idTokenHint,
                    }));
                  } catch {}
                }
                import('./stores/toast.js').then(({ showSuccess }) => showSuccess('Signed in'));
                await loadAuthState();
                // Re-evaluate the NativeSetup gate. Without this the user
                // completes OIDC from NativeSetup, gets a valid token, and
                // stays visually stuck on the setup screen — because the
                // showNativeSetup flag was captured at App.svelte mount and
                // never re-checked. needsNativeSetup() reads the current
                // nativeMode + serverUrl which NativeSetup persists before
                // opening the OIDC browser, so this correctly flips to
                // false and reveals the router. Cross-app fix mirrored
                // from NutriTrace #110.
                showNativeSetup = needsNativeSetup();
                window.location.hash = '#/';
              }
            }
          } catch (e) {
            console.warn('[app] deep link parse error:', e);
          }
        });
      });
    }

    await loadAuthState();
    await handleOidcCallback();

    // Env-lock state for AI / SMTP / OIDC. Fetched globally so the Trace
    // FAB knows about env-set AI_ENABLED without waiting for Settings to
    // load. Mirrors NutriTrace #36.
    loadEnvLocks();

    // Wizard gate. The web "no user + no user management" case is fully
    // covered by $setupRequired (the server distinguishes a fresh install
    // from intentional single-user mode via the single_user_mode flag in
    // app_config; see server/routes/auth.js GET /status). Native local
    // mode shows the wizard for goals/units/profile setup on first launch.
    // Same fix as NutriTrace #34.
    const _isNativeServer = isNative && getNativeMode() === 'server';
    const _isNativeLocal = isNative && getNativeMode() === 'local';
    if (!isNative && $setupRequired) {
      window.location.hash = '#/wizard';
    } else if (_isNativeLocal && !DB.getSetting('setupComplete', false)) {
      window.location.hash = '#/wizard';
    }

    // Sync engine — native server-connected mode only.
    if (isNative && getNativeMode() === 'server') {
      import('./lib/sync.js').then((mod) => {
        mod.syncState.subscribe(v => syncState.set(v));
        mod.startNetworkMonitor();
        mod.fullSync();
        setInterval(() => mod.fullSync(true), 30000);
        import('@capacitor/app').then(({ App }) => {
          App.addListener('resume', () => mod.fullSync());
        });
      });
    }

    // Auto-detect timezone
    const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detectedTz && !DB.getSetting('timezone', '')) {
      DB.setSetting('timezone', detectedTz);
      import('./stores/settings.js').then(({ scheduleSave }) => scheduleSave('timezone', detectedTz));
    }

    // PWA settings refresh
    if (!isNative && $userMgmtActive && $currentUser) {
      const _refreshSettings = () => import('./stores/settings.js').then(({ loadServerSettings }) => loadServerSettings());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') _refreshSettings();
      });
      setInterval(_refreshSettings, 30000);
    }
  });

  /**
   * Which sections the server holds by environment variable, Trace included.
   * Goes through NoteApi so the Android app sends its token: a bare fetch()
   * was answered with 401 there, which left Trace looking unconfigured even
   * with AI_* set on the server.
   */
  async function loadEnvLocks() {
    if (isNative && !getServerUrl()) return;
    try {
      const d = await NoteApi.get('/api/app-config/env-locks');
      if (!d) return;
      const { envLocks } = await import('./stores/settings.js');
      envLocks.set(d);
    } catch { /* defaults stay: Trace waits for a key in Settings */ }
  }

  const AUTH_BYPASS = ['/forgot-password', '/reset-password', '/accept-invite'];
  $: needsLogin = $userMgmtActive && !$currentUser && !AUTH_BYPASS.includes($location);

  let _wasNeedsLogin = needsLogin;
  $: {
    if (_wasNeedsLogin && !needsLogin && $currentUser) {
      _wasNeedsLogin = false;
      import('./stores/settings.js').then(({ loadServerSettings }) => loadServerSettings()).catch(() => {});
      loadEnvLocks();
    } else if (needsLogin) {
      _wasNeedsLogin = true;
    }
  }

  // Ctrl+K / Cmd+K jumps to note search from anywhere. Not while a note
  // editor or dialog is open, where the shortcut would pull focus away.
  async function _searchShortcut(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return;
    if (document.querySelector('.editor-backdrop, [role="dialog"][aria-modal="true"]')) return;
    e.preventDefault();
    const onNotes = $location === '/' || /^\/(notes|shared|archive|trash|reminders|label\/)/.test($location);
    if (!onNotes) { await push('/'); await new Promise(r => setTimeout(r, 60)); }
    window.dispatchEvent(new CustomEvent('note:focus-search'));
  }
</script>

<svelte:window
  on:keydown={_searchShortcut}
  on:touchstart|capture={_startPullSync}
  on:touchmove|nonpassive|capture={_movePullSync}
  on:touchend|capture={_finishPullSync}
  on:touchcancel|capture={_cancelPullSync}
/>

{#if showNativeSetup}
  <NativeSetup />
  <Toast />

{:else if needsLogin}
  <Login />
{:else}

{#if $appLocked}<LockScreen />{/if}

<Sidebar bind:open={sidebarOpen} persistent={sidebarPinned} {railStore} on:close={() => { if (!sidebarPinned) sidebarOpen = false; }} />


<!-- In-app update banner (native only). Renders only if the OS-level
     notification permission is denied — grants suppress the banner and
     route through a shade notification instead. -->
{#if !needsLogin}<UpdateBanner />{/if}

{#if showHamburger && $currentUser}
  <header class="app-topbar">
    <button
      class="hamburger"
      on:click={() => sidebarOpen = !sidebarOpen}
      aria-label="Open menu"
    >
      <span class="material-symbols-rounded">menu</span>
      {#if _syncModeActive && !_serverReachable}
        <!-- Amber for offline (nothing lost, it just hasn't gone yet), red when
             the server is reachable but the sync is failing. Same rule as the
             sidebar's sync line and the pill at the top. -->
        <span class="conn-badge" class:conn-failing={$syncState.online && $syncState.connectionIssue} class:conn-offline={!($syncState.online && $syncState.connectionIssue)}>
          <span class="material-symbols-rounded" style="font-size:10px">{$syncState.online && $syncState.connectionIssue ? 'cloud_alert' : 'cloud_off'}</span>
        </span>
      {/if}
    </button>
    <div class="topbar-spacer"></div>
  </header>
{/if}

{#if _syncModeActive && !needsLogin && _syncBannerCopy}
  <div class="sync-connection-banner {_syncBannerCopy.tone || 'bad'}"
    use:portal
    transition:slide={{ duration: $disableAnimations ? 0 : 200 }}>
    <span class="material-symbols-rounded sync-banner-icon">{_syncBannerCopy.icon}</span>
    <div class="sync-banner-copy">
      <div class="sync-banner-title">{_syncBannerCopy.title}</div>
      <div class="sync-banner-detail">{_syncBannerCopy.detail}</div>
    </div>
    <button class="sync-banner-btn sync-banner-retry"
      on:click={_retryServerConnection}
      disabled={_retryingConnection || $syncState.syncing}>
      {_retryingConnection ? $_('sync.retrying') : $_('sync.retry')}
    </button>
    <button class="sync-banner-btn sync-banner-dismiss"
      on:click={_dismissSyncBanner}
      aria-label={$_('sync.dismiss_message')}>
      <span class="material-symbols-rounded">close</span>
    </button>
  </div>
{/if}

<!-- Pull-to-refresh spinner: portalled so it floats above whatever
     route is mounted. Rotates the arrow to signal "release to sync"
     once the drag passes threshold, then swaps to a spinning refresh
     icon while the sync round is in flight. Placement + damping
     mirror NT exactly (safe-area top, sidebar-aware horizontal
     center, 0.45x translate for a slower reveal). Gated on
     _syncModeActive so PWA / native-standalone don't accidentally
     spawn one. -->
{#if _pullEnabled && !sidebarOpen && (_pullDistance > 0 || _pullRefreshing)}
  <div
    class="pull-sync-indicator"
    class:ready-to-sync={_pullDistance >= PULL_SYNC_THRESHOLD}
    use:portal
    style:transform={`translate(-50%, ${Math.round(_pullDistance * 0.45)}px)`}
    aria-hidden="true"
  >
    <span class="material-symbols-rounded" class:pull-sync-spin={_pullRefreshing}>
      {_pullRefreshing ? 'autorenew' : 'arrow_downward'}
    </span>
  </div>
{/if}

{#key $location}
  <!-- Uniform soft route transition: a subtle 8px rise + fade-in over
       200ms when entering a new route, paired with a quick fade-out on
       the old one. Gives every list → detail → editor hop a touch of
       polish without per-route choreography. Respects the user's
       reduce-motion / disable-animations preference. -->
  <main
    class="page-transition"
    class:has-topbar={showNav}
    in:fly={{ y: 8, duration: $disableAnimations ? 0 : 200, easing: cubicOut }}
    out:fade={{ duration: $disableAnimations ? 0 : 120 }}
  >
    <Router {routes} />
  </main>
{/key}

{#if hasBottomNav}
  <BottomNav />
{/if}

<Toast />
<Trace />
{#if !isNative}<OfflineStatus />{/if}

{/if}

{#if needsLogin}<Toast />{/if}
<ConfirmDialogMount />

<style>
  :global(body) { overflow-x: hidden; }

  :global(.no-animations *) {
    transition-duration: 0ms !important;
    animation-duration: 0ms !important;
  }

  .app-topbar {
    position: fixed;
    top: var(--safe-top);
    left: 0; right: 0;
    height: 0;
    z-index: 40;
    pointer-events: none;
  }

  .hamburger {
    position: fixed;
    top: calc(var(--safe-top) + 10px);
    left: 12px;
    width: 40px; height: 40px;
    border-radius: var(--radius-md);
    background: rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(10px) saturate(160%);
    -webkit-backdrop-filter: blur(10px) saturate(160%);
    border: 1px solid rgba(255, 255, 255, 0.18);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    z-index: 41;
    pointer-events: all;
    color: #ffffff;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    transition: background var(--dur-fast), transform var(--dur-fast) var(--ease-spring);
  }
  .hamburger:hover  { background: rgba(0, 0, 0, 0.5); }
  .hamburger:active { transform: scale(0.92); }

  .topbar-spacer { flex: 1; }

  :global(.page-transition) {
    position: fixed;
    top: 0;
    left: var(--sidebar-w, 0px);
    right: 0;
    bottom: 0;
    overflow-y: auto;
    /* Clip any horizontal overflow so iOS can't grab it as a
       pannable region. Sits on the real scroll container so a stray
       wide element on any page (Recipes was the reported culprit)
       never lets the whole view drift left/right. */
    overflow-x: hidden;
    transition: left 240ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  :global(.bottom-nav) {
    left: var(--sidebar-w, 0px) !important;
    transition: left 240ms cubic-bezier(0.2, 0.8, 0.2, 1) !important;
  }

  .conn-badge {
    position: absolute;
    top: -2px;
    right: -2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 2px solid var(--surface-1);
    transition: background 0.3s;
  }
  .conn-offline {
    background: var(--warning);
    color: #1b1300;
  }
  .conn-failing {
    background: var(--danger);
    color: #fff;
  }


  /* Smart connection banner. Ported from NT so it sits BELOW the
     device status bar and the app's compact header instead of covering
     the clock / hamburger on Android. */
  .sync-connection-banner {
    position: fixed;
    top: calc(var(--safe-top) + 60px);
    left: calc(var(--sidebar-w, 0px) + 12px);
    right: 12px;
    z-index: 250;
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px;
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 8%, var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--danger) 25%, var(--border));
    /* Same rule as the rest of the app: amber for no network, red for a
       server that can't be reached or is answering with errors. */
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg);
    font-size: 12px;
    font-weight: 500;
    transition: left 0.25s ease;
  }
  .sync-connection-banner.wait {
    color: var(--warning);
    background: color-mix(in srgb, var(--warning) 8%, var(--surface-2));
    border-color: color-mix(in srgb, var(--warning) 25%, var(--border));
  }
  .sync-connection-banner.wait .sync-banner-btn { color: var(--warning); }
  .sync-banner-icon {
    flex: 0 0 auto;
    font-size: 18px;
  }
  .sync-banner-copy {
    min-width: 0; flex: 1;
    display: flex; flex-direction: column; gap: 2px;
    line-height: 1.35;
  }
  .sync-banner-title { font-size: 13px; font-weight: 600; }
  .sync-banner-detail { color: var(--text-2); font-weight: 400; }
  .sync-banner-btn {
    flex: 0 0 auto;
    border: 0;
    color: var(--danger);
    background: transparent;
    font: inherit; font-weight: 600;
    cursor: pointer;
  }
  .sync-banner-btn:disabled { opacity: 0.6; cursor: default; }
  .sync-banner-dismiss {
    display: flex; align-items: center;
    padding: 2px;
  }
  .sync-banner-dismiss .material-symbols-rounded { font-size: 18px; }

  /* Pull-to-refresh circular indicator — mirrors NT App.svelte exactly.
     Fixed top with safe-area offset so it clears the status bar; left
     accounts for a persistent sidebar so it centers over the CONTENT
     area, not the whole viewport. */
  .pull-sync-indicator {
    position: fixed;
    top: calc(var(--safe-top, 0px) + 8px);
    left: calc(var(--sidebar-w, 0px) + (100vw - var(--sidebar-w, 0px)) / 2);
    z-index: 251;
    width: 36px; height: 36px;
    display: flex; align-items: center; justify-content: center;
    color: var(--text-2);
    background: var(--surface-3);
    border: 1px solid var(--border-strong);
    border-radius: 50%;
    box-shadow: var(--shadow-lg);
    pointer-events: none;
    transition: color 120ms, border-color 120ms;
  }
  .pull-sync-indicator.ready-to-sync {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  }
  .pull-sync-indicator .material-symbols-rounded {
    font-size: 20px;
    transition: transform 120ms;
  }
  .pull-sync-indicator.ready-to-sync .material-symbols-rounded {
    transform: rotate(180deg);
  }
  @keyframes pull-sync-spin { to { transform: rotate(360deg); } }
  .pull-sync-indicator .pull-sync-spin {
    animation: pull-sync-spin 0.8s linear infinite;
  }
</style>
