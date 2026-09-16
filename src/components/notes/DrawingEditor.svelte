<script>
  /**
   * DrawingEditor: a whiteboard for a note, full screen.
   *
   *   Pen, marker, and highlighter (pressure from a stylus), a stroke eraser,
   *   and a lasso to move or delete strokes. Colours and three sizes per tool,
   *   remembered on this device. Undo and redo. A paper or dark sheet with dots,
   *   squares, or lines. The sheet grows downward as you draw near its end.
   *
   *   Mouse: wheel scrolls, Ctrl or Cmd with the wheel zooms, the middle button
   *   or Space and drag pans. Touch: two fingers pan and zoom. With a stylus,
   *   fingers never draw (palm rejection) and one finger pans.
   *
   * Emits `done` with { drawing, changed }; the note editor turns it into the
   * picture and saves both.
   */
  import { onMount, onDestroy, createEventDispatcher, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { _ } from 'svelte-i18n';
  import { portal } from '../../lib/portal.js';
  import { onBack } from '../../lib/back-stack.js';
  import { emptyDrawing, parseDrawing, strokesBounds, strokeHit, strokesInLasso, moveStroke, MAX_BOARD_HEIGHT } from '../../../server/lib/drawing-meta.js';
  import { PALETTE, HIGHLIGHTS, SIZES, SHEET, INK, drawSheet, drawStroke, inkFor } from '../../lib/drawing-render.js';

  export let drawing = null;
  export let busy = false;

  const dispatch = createEventDispatcher();
  const PREFS_KEY = 'note:drawingTools';
  const TOOLS = [
    { key: 'pen', icon: 'stylus', label: 'drawing.pen', shortcut: 'p' },
    { key: 'marker', icon: 'ink_marker', label: 'drawing.marker', shortcut: 'm' },
    { key: 'highlighter', icon: 'ink_highlighter', label: 'drawing.highlighter', shortcut: 'h' },
    { key: 'eraser', icon: 'ink_eraser', label: 'drawing.eraser', shortcut: 'e' },
    { key: 'lasso', icon: 'lasso_select', label: 'drawing.lasso', shortcut: 's' },
  ];
  const DRAW_TOOLS = ['pen', 'marker', 'highlighter'];
  const DESK = '#0e0f13';

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; }
  }
  const prefs = loadPrefs();

  let doc = (drawing && parseDrawing(drawing)) || emptyDrawing(prefs.bg === 'dark' ? 'dark' : 'paper', prefs.grid || 'none');
  let strokes = doc.strokes;
  let tool = TOOLS.some(t => t.key === prefs.tool) ? prefs.tool : 'pen';
  let colors = { pen: INK, marker: '#1e88e5', highlighter: HIGHLIGHTS[0], ...(prefs.colors || {}) };
  let sizes = { pen: 2, marker: 2, highlighter: 2, ...(prefs.sizes || {}) };
  let undoStack = [];
  let redoStack = [];
  let dirty = false;
  let selection = [];
  let sheetOpen = false;
  let paletteOpen = false;

  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ tool, colors, sizes, bg: doc.bg, grid: doc.grid })); } catch { /* private mode */ }
  }
  $: tool, colors, sizes, savePrefs();

  // ── History ──────────────────────────────────────────────────────
  const snapshot = () => ({ strokes, bg: doc.bg, grid: doc.grid, h: doc.h });
  function restore(s) { strokes = s.strokes; doc = { ...doc, bg: s.bg, grid: s.grid, h: s.h }; selection = []; baseDirty = true; redraw(); }
  function commit(change) {
    undoStack = [...undoStack.slice(-199), snapshot()];
    redoStack = [];
    change();
    dirty = true;
    baseDirty = true;
    redraw();
  }
  function undo() { if (!undoStack.length) return; redoStack = [...redoStack, snapshot()]; restore(undoStack[undoStack.length - 1]); undoStack = undoStack.slice(0, -1); dirty = true; }
  function redo() { if (!redoStack.length) return; undoStack = [...undoStack, snapshot()]; restore(redoStack[redoStack.length - 1]); redoStack = redoStack.slice(0, -1); dirty = true; }

  // ── View ─────────────────────────────────────────────────────────
  let stage, canvas, ctx;
  let vw = 0, vh = 0, dpr = 1;
  let scale = 1, ox = 0, oy = 0;
  let fitScale = 1;
  let base = null, baseDirty = true;   // everything already drawn, cached for the current view

  function fit() {
    fitScale = Math.max(0.05, Math.min(3, (vw - 24) / doc.w));
    // A new sheet reaches the bottom of the screen, so a tall phone isn't mostly desk.
    if (!strokes.length && doc.h * fitScale < vh - 24) doc = { ...doc, h: Math.min(MAX_BOARD_HEIGHT, Math.ceil((vh - 24) / fitScale / 100) * 100) };
    scale = fitScale;
    ox = (vw - doc.w * scale) / 2;
    oy = 12;
    baseDirty = true;
    redraw();
  }
  function clampView() {
    const minScale = fitScale * 0.5, maxScale = Math.max(6, fitScale * 8);
    scale = Math.min(maxScale, Math.max(minScale, scale));
    const bw = doc.w * scale, bh = doc.h * scale;
    ox = Math.min(vw * 0.6, Math.max(vw * 0.4 - bw, ox));
    oy = Math.min(vh * 0.6, Math.max(vh * 0.4 - bh, oy));
  }
  function zoomAt(sx, sy, factor) {
    const bx = (sx - ox) / scale, by = (sy - oy) / scale;
    scale *= factor;
    clampView();
    ox = sx - bx * scale;
    oy = sy - by * scale;
    clampView();
    baseDirty = true;
    redraw();
  }
  $: zoomLabel = `${Math.round((scale / fitScale) * 100)}%`;

  function resize() {
    if (!stage || !canvas) return;
    const r = stage.getBoundingClientRect();
    const first = !vw;
    vw = r.width; vh = r.height;
    dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    canvas.style.width = `${vw}px`;
    canvas.style.height = `${vh}px`;
    if (first) fit(); else { fitScale = Math.max(0.05, Math.min(3, (vw - 24) / doc.w)); clampView(); baseDirty = true; redraw(); }
  }

  // ── Painting ─────────────────────────────────────────────────────
  let raf = 0;
  function redraw() { if (!raf && typeof requestAnimationFrame !== 'undefined') raf = requestAnimationFrame(paint); }

  function paintBase() {
    if (!base) base = document.createElement('canvas');
    base.width = canvas.width; base.height = canvas.height;
    const b = base.getContext('2d');
    b.setTransform(dpr, 0, 0, dpr, 0, 0);
    b.fillStyle = DESK;
    b.fillRect(0, 0, vw, vh);
    b.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
    // The sheet, with a soft shadow, then only the part of it that's on screen.
    b.save();
    b.shadowColor = 'rgba(0, 0, 0, 0.45)';
    b.shadowBlur = 24 * dpr;
    b.fillStyle = SHEET[doc.bg];
    b.fillRect(0, 0, doc.w, doc.h);
    b.restore();
    const view = { x: Math.max(0, -ox / scale), y: Math.max(0, -oy / scale) };
    view.w = Math.min(doc.w, (vw - ox) / scale) - view.x;
    view.h = Math.min(doc.h, (vh - oy) / scale) - view.y;
    if (view.w > 0 && view.h > 0) drawSheet(b, doc.bg, doc.grid, view, scale);
    b.save();
    b.beginPath(); b.rect(0, 0, doc.w, doc.h); b.clip();
    const hidden = gesture?.kind === 'erase' ? gesture.removed : null;
    const moving = gesture?.kind === 'move' ? selectedSet : null;
    for (let i = 0; i < strokes.length; i++) {
      if (hidden?.has(i) || moving?.has(i)) continue;
      drawStroke(b, strokes[i], doc.bg);
    }
    b.restore();
    baseDirty = false;
  }

  function paint() {
    raf = 0;
    if (!ctx) return;
    if (baseDirty || !base) paintBase();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, doc.w, doc.h); ctx.clip();
    if (gesture?.kind === 'move') {
      ctx.save();
      ctx.translate(gesture.dx, gesture.dy);
      for (const i of selectedSet) if (strokes[i]) drawStroke(ctx, strokes[i], doc.bg);
      ctx.restore();
    }
    if (gesture?.kind === 'draw' && gesture.stroke.p.length >= 3) drawStroke(ctx, gesture.stroke, doc.bg, true);
    ctx.restore();
    // Lasso line, selection box, and the tool under a hovering pointer.
    ctx.lineWidth = 1.5 / scale;
    if (gesture?.kind === 'lasso' && gesture.poly.length > 1) {
      ctx.setLineDash([6 / scale, 5 / scale]);
      ctx.strokeStyle = doc.bg === 'dark' ? '#b69cff' : '#6b4fd8';
      ctx.beginPath();
      gesture.poly.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (selBox) {
      const dx = gesture?.kind === 'move' ? gesture.dx : 0, dy = gesture?.kind === 'move' ? gesture.dy : 0;
      ctx.setLineDash([7 / scale, 5 / scale]);
      ctx.strokeStyle = '#7fa8ff';
      ctx.strokeRect(selBox.x + dx, selBox.y + dy, selBox.w, selBox.h);
      ctx.setLineDash([]);
    }
    if (hover && !gesture && (tool === 'eraser' || DRAW_TOOLS.includes(tool))) {
      ctx.beginPath();
      const r = tool === 'eraser' ? eraserRadius() : SIZES[tool][sizes[tool] - 1] / 2;
      ctx.arc(hover[0], hover[1], Math.max(r, 1.5 / scale), 0, Math.PI * 2);
      if (tool === 'eraser') { ctx.strokeStyle = doc.bg === 'dark' ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)'; ctx.stroke(); }
      else { ctx.fillStyle = inkFor(colors[tool], doc.bg); ctx.globalAlpha = tool === 'highlighter' ? 0.4 : 0.85; ctx.fill(); ctx.globalAlpha = 1; }
    }
  }

  // ── Selection ────────────────────────────────────────────────────
  $: selectedSet = new Set(selection);
  $: selBox = selection.length ? strokesBounds(selection.map(i => strokes[i]).filter(Boolean), 12) : null;
  $: selection, redraw();
  function deleteSelection() {
    if (!selection.length) return;
    const gone = new Set(selection);
    commit(() => { strokes = strokes.filter((_, i) => !gone.has(i)); });
    selection = [];
  }
  $: selBar = selBox ? { left: Math.min(vw - 150, Math.max(8, ox + (selBox.x + selBox.w / 2) * scale - 70)), top: Math.max(8, oy + selBox.y * scale - 52) } : null;

  // ── Pointers ─────────────────────────────────────────────────────
  const pointers = new Map();
  let penSeen = false;
  let gesture = null;
  let pinch = null;
  let pan = null;
  let spaceHeld = false;
  let hover = null;

  const eraserRadius = () => 14 / scale;
  function toBoard(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return [(clientX - r.left - ox) / scale, (clientY - r.top - oy) / scale];
  }
  function addPoints(e) {
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const events = list.length ? list : [e];
    const p = gesture.stroke.p;
    for (const ev of events) {
      const [x, y] = toBoard(ev.clientX, ev.clientY);
      const pressure = e.pointerType === 'pen' ? (ev.pressure || 0.5) : 0.5;
      const n = p.length;
      if (n >= 3 && Math.abs(p[n - 3] / 2 - x) < 0.6 && Math.abs(p[n - 2] / 2 - y) < 0.6) continue;
      p.push(Math.round(x * 2), Math.round(y * 2), Math.round(pressure * 100));
    }
  }
  function eraseAt(x, y) {
    const r = eraserRadius();
    let hit = false;
    for (let i = 0; i < strokes.length; i++) {
      if (gesture.removed.has(i)) continue;
      const pad = (SIZES[strokes[i].t]?.[strokes[i].s - 1] || 4) / 2;
      if (strokeHit(strokes[i], x, y, r + pad)) { gesture.removed.add(i); hit = true; }
    }
    if (hit) { baseDirty = true; redraw(); }
  }
  const touchPoints = () => [...pointers.values()].filter(p => p.type === 'touch');

  function startPinch() {
    const [a, b] = touchPoints();
    if (!a || !b) return;
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }

  function onDown(e) {
    canvas.setPointerCapture?.(e.pointerId);
    if (e.pointerType === 'pen') penSeen = true;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    paletteOpen = false;
    if (e.pointerType === 'touch' && (penSeen || touchPoints().length >= 2)) {
      // A second finger (or any finger while a stylus is about) navigates: a
      // stroke the first finger only just started is taken back.
      if (gesture?.kind === 'draw' && gesture.pointerType === 'touch' && gesture.stroke.p.length < 36) { gesture = null; redraw(); }
      if (touchPoints().length >= 2) startPinch();
      else pan = { id: e.pointerId, x: e.clientX, y: e.clientY };
      return;
    }
    if (e.pointerType === 'mouse' && (e.button === 1 || (e.button === 0 && spaceHeld))) {
      pan = { id: e.pointerId, x: e.clientX, y: e.clientY };
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const [x, y] = toBoard(e.clientX, e.clientY);
    if (tool === 'lasso' && selBox && x >= selBox.x && x <= selBox.x + selBox.w && y >= selBox.y && y <= selBox.y + selBox.h) {
      gesture = { kind: 'move', id: e.pointerId, sx: x, sy: y, dx: 0, dy: 0 };
      baseDirty = true; redraw();
      return;
    }
    if (tool === 'eraser') { gesture = { kind: 'erase', id: e.pointerId, removed: new Set() }; eraseAt(x, y); return; }
    if (tool === 'lasso') { selection = []; gesture = { kind: 'lasso', id: e.pointerId, poly: [[x, y]] }; redraw(); return; }
    selection = [];
    gesture = { kind: 'draw', id: e.pointerId, pointerType: e.pointerType, stroke: { t: tool, c: colors[tool], s: sizes[tool], p: [] } };
    addPoints(e);
    redraw();
  }

  function onMove(e) {
    const pt = pointers.get(e.pointerId);
    if (pt) { pt.x = e.clientX; pt.y = e.clientY; }
    if (e.pointerType !== 'touch') hover = toBoard(e.clientX, e.clientY);
    if (pinch && touchPoints().length >= 2) {
      const [a, b] = touchPoints();
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const r = canvas.getBoundingClientRect();
      ox += cx - pinch.cx; oy += cy - pinch.cy;
      zoomAt(cx - r.left, cy - r.top, d / pinch.d);
      pinch = { d, cx, cy };
      return;
    }
    if (pan && pan.id === e.pointerId) {
      ox += e.clientX - pan.x; oy += e.clientY - pan.y;
      pan.x = e.clientX; pan.y = e.clientY;
      clampView(); baseDirty = true; redraw();
      return;
    }
    if (!gesture || gesture.id !== e.pointerId) { if (hover) redraw(); return; }
    const [x, y] = toBoard(e.clientX, e.clientY);
    if (gesture.kind === 'draw') addPoints(e);
    else if (gesture.kind === 'erase') eraseAt(x, y);
    else if (gesture.kind === 'lasso') gesture.poly.push([x, y]);
    else if (gesture.kind === 'move') { gesture.dx = x - gesture.sx; gesture.dy = y - gesture.sy; }
    redraw();
  }

  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pinch && touchPoints().length < 2) pinch = null;
    if (pan && pan.id === e.pointerId) pan = null;
    if (!gesture || gesture.id !== e.pointerId) return;
    const g = gesture;
    gesture = null;
    if (e.type === 'pointercancel' && g.kind === 'draw') { redraw(); return; }
    if (g.kind === 'draw' && g.stroke.p.length >= 3) {
      const stroke = g.stroke;
      commit(() => {
        strokes = [...strokes, stroke];
        // Drawing near the end of the sheet adds more of it.
        const b = strokesBounds([stroke]);
        if (b && b.y + b.h > doc.h - 240 && doc.h < MAX_BOARD_HEIGHT) doc = { ...doc, h: Math.min(MAX_BOARD_HEIGHT, Math.ceil((b.y + b.h + 800) / 400) * 400) };
      });
    } else if (g.kind === 'erase' && g.removed.size) {
      commit(() => { strokes = strokes.filter((_, i) => !g.removed.has(i)); });
    } else if (g.kind === 'lasso') {
      selection = strokesInLasso(strokes, g.poly);
    } else if (g.kind === 'move' && (g.dx || g.dy)) {
      const moving = new Set(selection);
      commit(() => { strokes = strokes.map((s, i) => moving.has(i) ? moveStroke(s, g.dx, g.dy) : s); });
    }
    baseDirty = true;
    redraw();
  }

  function onWheel(e) {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0022));
    else { ox -= e.shiftKey ? e.deltaY : e.deltaX; oy -= e.shiftKey ? 0 : e.deltaY; clampView(); baseDirty = true; redraw(); }
  }

  // ── Sheet, clearing, and closing ─────────────────────────────────
  function setSheet(bg, grid) {
    if (bg === doc.bg && grid === doc.grid) return;
    commit(() => { doc = { ...doc, bg, grid }; });
    savePrefs();
  }
  function clearAll() {
    sheetOpen = false;
    if (!strokes.length) return;
    commit(() => { strokes = []; });
    selection = [];
  }
  function done() {
    if (busy) return;
    dispatch('done', { drawing: { ...doc, strokes }, changed: dirty });
  }
  function pickTool(key) { tool = key; if (key !== 'lasso') selection = []; paletteOpen = false; redraw(); }

  function onKey(e) {
    if (e.target?.closest?.('input, textarea')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === ' ') { spaceHeld = true; if (canvas) canvas.style.cursor = 'grab'; e.preventDefault(); return; }
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (sheetOpen || paletteOpen) { sheetOpen = false; paletteOpen = false; }
      else if (selection.length) selection = [];
      else done();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection.length) { e.preventDefault(); deleteSelection(); return; }
    if (mod || e.altKey) return;
    const t = TOOLS.find(x => x.shortcut === e.key.toLowerCase());
    if (t) { e.preventDefault(); pickTool(t.key); }
    else if (e.key === '0') { e.preventDefault(); fit(); }
  }
  function onKeyUp(e) { if (e.key === ' ') { spaceHeld = false; if (canvas) canvas.style.cursor = ''; } }

  let observer;
  let releaseBack = () => {};
  onMount(async () => {
    await tick();
    ctx = canvas.getContext('2d');
    observer = new ResizeObserver(resize);
    observer.observe(stage);
    resize();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    releaseBack = onBack(done);
  });
  onDestroy(() => {
    observer?.disconnect();
    if (raf) cancelAnimationFrame(raf);
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
    }
    releaseBack();
  });

  $: palette = tool === 'highlighter' ? HIGHLIGHTS : PALETTE;
  $: drawTool = DRAW_TOOLS.includes(tool);
</script>

<div class="dw" use:portal role="dialog" aria-modal="true" aria-label={$_('drawing.title')} transition:fade={{ duration: 140 }}>
  <header class="dw-bar">
    <button class="dw-btn" on:click={done} aria-label={$_('drawing.close')} title={$_('drawing.close')} disabled={busy}>
      <span class="material-symbols-rounded">arrow_back</span>
    </button>
    <span class="dw-title">{$_('drawing.title')}</span>
    <span class="dw-spacer"></span>
    <button class="dw-btn" on:click={undo} disabled={!undoStack.length} aria-label={$_('drawing.undo')} title={`${$_('drawing.undo')} (Ctrl+Z)`}>
      <span class="material-symbols-rounded">undo</span>
    </button>
    <button class="dw-btn" on:click={redo} disabled={!redoStack.length} aria-label={$_('drawing.redo')} title={`${$_('drawing.redo')} (Ctrl+Shift+Z)`}>
      <span class="material-symbols-rounded">redo</span>
    </button>
    <button class="dw-btn" class:on={sheetOpen} on:click={() => { sheetOpen = !sheetOpen; paletteOpen = false; }} aria-label={$_('drawing.sheet')} title={$_('drawing.sheet')} aria-expanded={sheetOpen}>
      <span class="material-symbols-rounded">grid_on</span>
    </button>
    <button class="btn btn-primary dw-done" on:click={done} disabled={busy}>
      {#if busy}<span class="material-symbols-rounded spin">progress_activity</span>{/if}{busy ? $_('drawing.saving') : $_('drawing.done')}
    </button>
  </header>

  <div class="dw-stage" bind:this={stage}>
    <canvas bind:this={canvas} class="dw-canvas" class:erasing={tool === 'eraser'} class:lassoing={tool === 'lasso'}
      aria-label={$_('drawing.canvas')}
      on:pointerdown={onDown} on:pointermove={onMove} on:pointerup={onUp} on:pointercancel={onUp}
      on:pointerleave={() => { hover = null; redraw(); }}
      on:wheel|nonpassive={onWheel}
      on:contextmenu|preventDefault></canvas>

    {#if selBar && !gesture}
      <div class="dw-selbar" style="left:{selBar.left}px; top:{selBar.top}px">
        <button on:click={deleteSelection}><span class="material-symbols-rounded">delete</span>{$_('drawing.delete_selection')}</button>
        <button on:click={() => selection = []} aria-label={$_('drawing.deselect')}><span class="material-symbols-rounded">close</span></button>
      </div>
    {/if}

    <button class="dw-zoom" on:click={fit} title={`${$_('drawing.fit')} (0)`}>{zoomLabel}</button>

    {#if sheetOpen}
      <div class="dw-sheet" transition:fade={{ duration: 100 }}>
        <p class="dw-sub">{$_('drawing.sheet')}</p>
        <div class="dw-choice">
          {#each ['paper', 'dark'] as bg}
            <button class:on={doc.bg === bg} on:click={() => setSheet(bg, doc.grid)}>
              <span class="dw-swatch-sheet" style="background:{SHEET[bg]}"></span>{$_(`drawing.bg_${bg}`)}
            </button>
          {/each}
        </div>
        <div class="dw-choice">
          {#each [['none', 'crop_square'], ['dots', 'grain'], ['squares', 'grid_4x4'], ['lines', 'density_medium']] as [grid, icon]}
            <button class:on={doc.grid === grid} on:click={() => setSheet(doc.bg, grid)}>
              <span class="material-symbols-rounded">{icon}</span>{$_(`drawing.grid_${grid}`)}
            </button>
          {/each}
        </div>
        <button class="dw-clear" on:click={clearAll} disabled={!strokes.length}>
          <span class="material-symbols-rounded">delete_sweep</span>{$_('drawing.clear')}
        </button>
      </div>
    {/if}
  </div>

  <div class="dw-tools" role="toolbar" aria-label={$_('drawing.tools')}>
    <div class="dw-toolrow" role="radiogroup" aria-label={$_('drawing.tools')}>
      {#each TOOLS as t}
        <button class="dw-tool" class:on={tool === t.key} role="radio" aria-checked={tool === t.key}
          on:click={() => pickTool(t.key)} aria-label={$_(t.label)} title={`${$_(t.label)} (${t.shortcut.toUpperCase()})`}>
          <span class="material-symbols-rounded">{t.icon}</span>
          {#if DRAW_TOOLS.includes(t.key)}<span class="dw-ink" style="background:{inkFor(colors[t.key], doc.bg)}"></span>{/if}
        </button>
      {/each}
      {#if drawTool}
        <span class="dw-divider" aria-hidden="true"></span>
        <div class="dw-sizes" role="radiogroup" aria-label={$_('drawing.size')}>
          {#each [1, 2, 3] as n}
            <button class="dw-size" class:on={sizes[tool] === n} role="radio" aria-checked={sizes[tool] === n}
              on:click={() => sizes = { ...sizes, [tool]: n }} aria-label={$_(`drawing.size_${n}`)}>
              <span style="width:{4 + n * 4}px; height:{4 + n * 4}px"></span>
            </button>
          {/each}
        </div>
        <button class="dw-colorbtn" on:click={() => { paletteOpen = !paletteOpen; sheetOpen = false; }} aria-label={$_('drawing.color')} aria-expanded={paletteOpen}>
          <span style="background:{inkFor(colors[tool], doc.bg)}"></span>
        </button>
        <div class="dw-palette-inline" role="radiogroup" aria-label={$_('drawing.color')}>
          {#each palette as c}
            <button class="dw-color" class:on={colors[tool] === c} role="radio" aria-checked={colors[tool] === c}
              style="--c:{inkFor(c, doc.bg)}" on:click={() => colors = { ...colors, [tool]: c }} aria-label={c === INK ? $_('drawing.ink') : c}></button>
          {/each}
        </div>
      {/if}
    </div>
    {#if paletteOpen && drawTool}
      <div class="dw-palette-row" role="radiogroup" aria-label={$_('drawing.color')} transition:fade={{ duration: 100 }}>
        {#each palette as c}
          <button class="dw-color" class:on={colors[tool] === c} role="radio" aria-checked={colors[tool] === c}
            style="--c:{inkFor(c, doc.bg)}" on:click={() => { colors = { ...colors, [tool]: c }; paletteOpen = false; }} aria-label={c === INK ? $_('drawing.ink') : c}></button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .dw {
    position: fixed; inset: 0; z-index: 3000;
    display: flex; flex-direction: column;
    background: #0e0f13; color: #f1f1f4;
    user-select: none; -webkit-user-select: none;
  }
  .dw-bar {
    display: flex; align-items: center; gap: 4px; flex-shrink: 0;
    padding: calc(8px + var(--safe-top, 0px)) 10px 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    background: rgba(20, 21, 27, 0.96);
  }
  .dw-title { margin-left: 4px; font-size: 16px; font-weight: 600; }
  .dw-spacer { flex: 1; }
  .dw-btn {
    width: 40px; height: 40px; border-radius: 12px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center; color: #e6e6ec;
  }
  .dw-btn:hover:not(:disabled), .dw-btn.on { background: rgba(255, 255, 255, 0.1); }
  .dw-btn:disabled { opacity: 0.35; }
  .dw-done { margin-left: 6px; height: 38px; display: inline-flex; align-items: center; gap: 6px; }
  .dw-stage { position: relative; flex: 1; min-height: 0; overflow: hidden; }
  .dw-canvas { position: absolute; inset: 0; display: block; touch-action: none; cursor: crosshair; }
  .dw-canvas.erasing { cursor: none; }
  .dw-canvas.lassoing { cursor: default; }
  .dw-zoom {
    position: absolute; right: 12px; bottom: 12px; height: 32px; padding: 0 12px; border-radius: 10px;
    background: rgba(20, 21, 27, 0.85); color: #e6e6ec; font-size: 12.5px; font-weight: 600;
    border: 1px solid rgba(255, 255, 255, 0.1); font-variant-numeric: tabular-nums;
  }
  .dw-selbar {
    position: absolute; display: flex; gap: 2px; padding: 4px; border-radius: 12px;
    background: rgba(20, 21, 27, 0.95); border: 1px solid rgba(255, 255, 255, 0.12); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .dw-selbar button { height: 34px; padding: 0 10px; border-radius: 9px; display: inline-flex; align-items: center; gap: 6px; color: #fff; font-size: 13px; font-weight: 600; }
  .dw-selbar button:hover { background: rgba(255, 255, 255, 0.12); }
  .dw-selbar .material-symbols-rounded { font-size: 18px; }
  .dw-sheet {
    position: absolute; top: 10px; right: 10px; width: min(300px, calc(100% - 20px));
    padding: 12px; border-radius: 16px; display: flex; flex-direction: column; gap: 10px;
    background: rgba(24, 25, 32, 0.98); border: 1px solid rgba(255, 255, 255, 0.1); box-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
  }
  .dw-sub { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(255, 255, 255, 0.55); }
  .dw-choice { display: flex; flex-wrap: wrap; gap: 6px; }
  .dw-choice button {
    display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 10px; border-radius: 10px;
    color: #e6e6ec; font-size: 13px; background: rgba(255, 255, 255, 0.06); border: 1px solid transparent;
  }
  .dw-choice button.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 22%, transparent); }
  .dw-choice .material-symbols-rounded { font-size: 18px; }
  .dw-swatch-sheet { width: 16px; height: 16px; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.3); }
  .dw-clear { display: inline-flex; align-items: center; gap: 8px; height: 38px; padding: 0 10px; border-radius: 10px; color: #ff8a80; font-size: 14px; }
  .dw-clear:hover:not(:disabled) { background: rgba(255, 138, 128, 0.12); }
  .dw-clear:disabled { opacity: 0.4; }
  .dw-tools {
    flex-shrink: 0; display: flex; flex-direction: column; align-items: center; gap: 6px;
    padding: 8px 10px calc(10px + var(--safe-bottom, 0px));
    border-top: 1px solid rgba(255, 255, 255, 0.07); background: rgba(20, 21, 27, 0.96);
  }
  .dw-toolrow { display: flex; align-items: center; gap: 4px; max-width: 100%; overflow-x: auto; scrollbar-width: none; }
  .dw-toolrow::-webkit-scrollbar { display: none; }
  .dw-tool {
    position: relative; width: 46px; height: 46px; border-radius: 14px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center; color: #cfd0d8;
  }
  .dw-tool .material-symbols-rounded { font-size: 24px; }
  .dw-tool:hover { background: rgba(255, 255, 255, 0.08); }
  .dw-tool.on { background: color-mix(in srgb, var(--accent) 26%, transparent); color: #fff; }
  .dw-ink { position: absolute; bottom: 6px; left: 50%; transform: translateX(-50%); width: 14px; height: 3px; border-radius: 2px; }
  .dw-divider { width: 1px; height: 26px; background: rgba(255, 255, 255, 0.12); margin: 0 6px; flex-shrink: 0; }
  .dw-sizes { display: flex; gap: 2px; flex-shrink: 0; }
  .dw-size { width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; }
  .dw-size span { border-radius: 50%; background: #cfd0d8; }
  .dw-size.on { background: rgba(255, 255, 255, 0.12); }
  .dw-size.on span { background: #fff; }
  .dw-colorbtn { display: none; width: 40px; height: 40px; border-radius: 12px; align-items: center; justify-content: center; flex-shrink: 0; }
  .dw-colorbtn span { width: 22px; height: 22px; border-radius: 50%; border: 2px solid rgba(255, 255, 255, 0.85); }
  .dw-palette-inline, .dw-palette-row { display: flex; gap: 4px; flex-shrink: 0; }
  .dw-palette-row { flex-wrap: wrap; justify-content: center; }
  .dw-color {
    width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0; position: relative;
    background: var(--c); border: 2px solid rgba(255, 255, 255, 0.18);
  }
  .dw-color.on { border-color: #fff; box-shadow: 0 0 0 2px var(--accent); }
  @media (max-width: 760px) {
    .dw-palette-inline { display: none; }
    .dw-colorbtn { display: flex; }
    .dw-title { display: none; }
    .dw-tool { width: 42px; height: 42px; }
    .dw-size { width: 32px; }
  }
  .spin { animation: spin 1s linear infinite; font-size: 18px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
