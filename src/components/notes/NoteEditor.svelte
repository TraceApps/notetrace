<script>
  /**
   * NoteEditor: open, create, and edit a single note.
   *
   * Centered panel on wide screens, full screen on phones. Saves as you
   * type (debounced) and never shows a Save button. A new note is only
   * created once it has content, and closing an untouched new note leaves
   * nothing behind.
   *
   * Every save goes through one queue so operations on a brand-new note
   * wait for its create call instead of racing it.
   */
  import LabelGlyph from './LabelGlyph.svelte';
  import { onMount, onDestroy, createEventDispatcher, tick } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { disableAnimations, tasksAllChecklists } from '../../stores/settings.js';
  import { cubicOut } from 'svelte/easing';
  import { _ } from 'svelte-i18n';
  import { portal } from '../../lib/portal.js';
  import { dialogFocus } from '../../lib/dialog-focus.js';
  import { NoteApi } from '../../lib/api.js';
  import { labelsById, signalNotesChanged, signalCountsChanged, refreshLabels } from '../../stores/notes.js';
  import { noteColorStyle, colorDot } from '../../lib/note-colors.js';
  import { isEmptyNote } from '../../lib/note-preview.js';
  import { relativeTime } from '../../lib/relative-time.js';
  import { confirmDialog, promptDialog } from '../../stores/confirmDialog.js';
  import { printNote } from '../../lib/note-print.js';
  import { templateFromNote, canTemplate, cleanTemplates, MAX_TEMPLATES, MAX_NAME } from '../../lib/note-templates.js';
  import { noteTemplates } from '../../stores/settings.js';
  import { showError, showInfo, showUndo } from '../../stores/toast.js';
  import TipTapEditor from './TipTapEditor.svelte';
  import ChecklistEditor from './ChecklistEditor.svelte';
  import ColorPalette from './ColorPalette.svelte';
  import LabelPicker from './LabelPicker.svelte';
  import Popover from './Popover.svelte';
  import VersionHistory from './VersionHistory.svelte';
  import ReminderPicker from './ReminderPicker.svelte';
  import ReminderChip from './ReminderChip.svelte';
  import { ensureReminderPermission, rescheduleReminders } from '../../lib/note-reminders.js';
  import ShareDialog from './ShareDialog.svelte';
  import TraceActions from './TraceActions.svelte';
  import CooktraceSend from './CooktraceSend.svelte';
  import { cooktraceLink, cooktraceOn, loadCooktraceLink } from '../../lib/cooktrace.js';
  import VoiceRecorder from './VoiceRecorder.svelte';
  import VoiceNotes from './VoiceNotes.svelte';
  import FileAttachments from './FileAttachments.svelte';
  import FileViewer from './FileViewer.svelte';
  import DrawingEditor from './DrawingEditor.svelte';
  import { isFile, previewKind } from '../../lib/file-kinds.js';
  import { fileIndexPatch } from '../../lib/file-index.js';
  import { recordingSupported, uploadVoiceNote, formatDuration } from '../../lib/voice-recorder.js';
  import { extractSupport, transcribeVoiceNote, summarizeVoiceNote, readImageText, fetchAttachmentBlob, isAudio, isImage } from '../../lib/ai-extract.js';
  import { autoTranscribe, autoSummarizeLong, autoReadImages } from '../../stores/settings.js';
  import { traceReady, askTrace, TRACE_ACTIONS, titleLine } from '../../lib/trace-run.js';
  import { AUTO_SUMMARY_MS, worthSummarizing } from '../../../server/lib/voice-meta.js';
  import { itemAfterPatch } from '../../../server/lib/task-rules.js';
  import { todayStr } from '../../lib/due-dates.js';
  import AttachmentGrid from './AttachmentGrid.svelte';
  import ImageViewer from './ImageViewer.svelte';
  import { uploadNoteImages, isImageFile } from '../../lib/note-images.js';
  import { isAudioFile, prepareAudioFile } from '../../lib/voice-files.js';
  import { pendingVoice, queueVoiceNote, flushPendingVoice, discardPendingVoice, hasPendingFor } from '../../lib/pending-voice.js';
  import { sharingAvailable } from '../../lib/note-sharing.js';

  /** Existing note, or null to create one. */
  export let note = null;
  /** Kind for a new note. */
  export let initialKind = 'text';
  /** Labels to apply to a new note (e.g. when created from a label view). */
  export let initialLabels = [];
  /** Content for a new note, e.g. from the share sheet: { title, body_md, images: File[] }. */
  export let prefill = null;

  const dispatch = createEventDispatcher();
  const TEXT_SAVE_MS = 700;

  let noteId = note?.id ?? null;
  let title = note?.title ?? prefill?.title ?? '';
  const openedTitle = note?.title ?? '';
  let body = note?.body_md ?? prefill?.body_md ?? '';
  let kind = note?.kind ?? prefill?.kind ?? initialKind;
  let color = note?.color ?? prefill?.color ?? null;
  let pinned = !!note?.pinned;
  let inTasks = !!note?.in_tasks;
  let archived = !!note?.archived;
  let trashed = !!note?.trashed_at;
  let noteLabels = note?.labels ? [...note.labels] : [...initialLabels];
  let items = note?.items ? note.items.map(i => ({ ...i })) : (prefill?.items || []).map(i => ({ ...i }));
  let attachments = note?.attachments ? [...note.attachments] : [];
  let uploading = 0;
  // Images removed here, so a save still in flight can't put them back on screen.
  const removedImages = new Set();
  let viewerIndex = null;
  let imageInput;
  let dragOver = false;
  let updatedAt = note?.updated_at ?? null;
  let reminderAt = note?.reminder_at ?? null;
  let reminderRepeat = note?.reminder_rrule ?? null;
  let reminderTz = note?.reminder_tz ?? null;
  let shareRole = note?.share_role ?? 'owner';
  let shareOwner = note?.share_owner ?? null;
  let shareCount = note?.share_count ?? 0;
  let editorKey = 0;
  let touched = false;

  let checklistRef;
  let bodyRef;
  let titleEl;
  let textTimer = null;
  let queue = Promise.resolve();
  let saving = false;
  let showHistory = false;
  let colorOpen = false, labelsOpen = false, reminderOpen = false, shareOpen = false, traceOpen = false, recordOpen = false, cookOpen = false;
  let colorAnchor = null, labelsAnchor = null, reminderAnchor = null, shareAnchor = null, traceAnchor = null, recordAnchor = null, cookAnchor = null;
  let narrow = typeof window !== 'undefined' && window.innerWidth < 600;

  $: readOnly = trashed;
  // Shared notes: 'view' members can't change content; reminders and
  // trash belong to the owner.
  $: isOwner = shareRole === 'owner';
  $: contentLocked = readOnly || shareRole === 'view';
  $: shared = shareRole !== 'owner' || shareCount > 0;
  $: chips = noteLabels.map(id => $labelsById.get(id)).filter(Boolean);
  // The reading pane's breadcrumb: the note's first label as a path (Home › Garage).
  $: crumb = chips.length ? chips[0].name.split('/').map(s => s.trim()).filter(Boolean).join(' › ')
    : archived ? $_('nav.archive') : $_('nav.notes');
  $: reminderNote = { reminder_at: reminderAt, reminder_rrule: reminderRepeat, reminder_tz: reminderTz };

  function enqueue(fn) {
    saving = true;
    const run = queue.then(fn).catch(e => { showError(e?.message || $_('notes.save_failed')); });
    queue = run.finally(() => { saving = false; });
    return run;
  }

  function apply(n) {
    if (!n) return;
    noteId = n.id;
    updatedAt = n.updated_at;
    pinned = !!n.pinned;
    inTasks = !!n.in_tasks;
    archived = !!n.archived;
    trashed = !!n.trashed_at;
    color = n.color;
    noteLabels = [...(n.labels || [])];
    attachments = (n.attachments || []).filter(a => !removedImages.has(a.uuid));
    reminderAt = n.reminder_at ?? null;
    reminderRepeat = n.reminder_rrule ?? null;
    reminderTz = n.reminder_tz ?? null;
    shareRole = n.share_role ?? shareRole;
    shareOwner = n.share_owner ?? null;
    shareCount = n.share_count ?? shareCount;
  }

  /** Create the note on first content. Resolves to its id. */
  async function ensureNote() {
    if (noteId) return noteId;
    const created = await NoteApi.createNote({
      title, body_md: kind === 'text' ? body : '', kind, color, pinned, in_tasks: kind === 'checklist' && inTasks,
      reminder_at: reminderAt, reminder_rrule: reminderRepeat, reminder_tz: reminderTz,
      labels: noteLabels,
      attachments,
      items: kind === 'checklist' ? items.map((i, idx) => ({ uuid: i.uuid, text: i.text, checked: i.checked, position: i.position ?? idx + 1 })) : [],
    });
    apply(created);
    return noteId;
  }

  function scheduleText() {
    touched = true;
    clearTimeout(textTimer);
    textTimer = setTimeout(saveText, TEXT_SAVE_MS);
  }

  function saveText() {
    clearTimeout(textTimer);
    textTimer = null;
    return enqueue(async () => {
      if (!noteId) {
        if (isEmptyNote({ title, body_md: body, items, attachments })) return;
        await ensureNote();
        return;
      }
      // Links follow a rename once, on close, not through every half-typed title.
      apply(await NoteApi.updateNote(noteId, kind === 'text' ? { title, body_md: body, rename_links: false } : { title, rename_links: false }));
    });
  }

  function patch(p) {
    touched = true;
    return enqueue(async () => {
      if (!noteId) {
        if (isEmptyNote({ title, body_md: body, items, attachments }) && !p.labels && !p.pinned && !p.in_tasks && !p.reminder_at) return;
        await ensureNote();
        if (!('archived' in p)) return;
      }
      apply(await NoteApi.updateNote(noteId, p));
    });
  }

  // ── Checklist ops ─────────────────────────────────────────────────
  function onItemAdd(e) {
    touched = true;
    const { uuid, text, position } = e.detail;
    items = [...items, { uuid, text, checked: false, position }];
    enqueue(async () => {
      if (!noteId) { await ensureNote(); return; }
      const n = await NoteApi.addItem(noteId, { uuid, text, position });
      updatedAt = n?.updated_at ?? updatedAt;
    });
  }
  function onItemUpdate(e) {
    touched = true;
    const { uuid, patch: p } = e.detail;
    // itemAfterPatch applies the repeat rule, so a repeating task moves on here too.
    items = items.map(i => i.uuid === uuid ? itemAfterPatch(i, p, p.today || todayStr()) : i);
    enqueue(async () => {
      if (!noteId) { await ensureNote(); return; }
      const n = await NoteApi.updateItem(noteId, uuid, p);
      updatedAt = n?.updated_at ?? updatedAt;
      if ('checked' in p || 'due_date' in p) signalCountsChanged();
    });
  }
  function onItemDelete(e) {
    touched = true;
    const { uuid } = e.detail;
    const at = items.findIndex(i => i.uuid === uuid);
    const gone = items[at];
    items = items.filter(i => i.uuid !== uuid);
    enqueue(async () => {
      if (!noteId) return;
      const n = await NoteApi.deleteItem(noteId, uuid);
      updatedAt = n?.updated_at ?? updatedAt;
    });
    if (gone) showUndo($_('notes.undo_item'), () => restoreItem(gone, at));
  }
  function restoreItem(item, at) {
    touched = true;
    items = [...items.slice(0, at), item, ...items.slice(at)];
    editorKey++;
    enqueue(async () => {
      if (!noteId) return;
      const n = await NoteApi.addItem(noteId, { uuid: item.uuid, text: item.text, checked: item.checked, position: item.position, due_date: item.due_date || null });
      updatedAt = n?.updated_at ?? updatedAt;
    });
  }
  function onItemReorder(e) {
    const { uuids } = e.detail;
    enqueue(async () => {
      if (!noteId) { await ensureNote(); return; }
      await NoteApi.reorderItems(noteId, uuids);
    });
  }

  // ── Voice notes and text in images ────────────────────────────────
  $: imageAttachments = attachments.filter(isImage);
  $: voiceNotes = attachments.filter(isAudio);
  let extracting = {};
  const canRecord = recordingSupported();

  function openRecorder(e) {
    recordAnchor = e.currentTarget.getBoundingClientRect();
    recordOpen = true;
  }

  // A quick voice note opens straight into recording. Its transcript becomes
  // the note's text and Trace suggests a title; discarding the recording of an
  // otherwise empty note closes it.
  let voiceFirst = false;
  async function startQuickVoice() {
    voiceFirst = true;
    await tick();
    recordAnchor = document.querySelector('.editor-panel [data-record]')?.getBoundingClientRect() || null;
    recordOpen = true;
  }
  function onRecordCancel() {
    recordOpen = false;
    if (voiceFirst && !noteId && isEmptyNote({ title, body_md: body, items, attachments })) close();
  }
  async function suggestTitle(text) {
    try {
      const reply = await askTrace({ systemPrompt: TRACE_ACTIONS.title.system, prompt: TRACE_ACTIONS.title.prompt('', text.slice(0, 4000)) });
      const t = titleLine(reply);
      if (t && !title.trim()) { title = t; scheduleText(); }
    } catch { /* the note keeps no title */ }
  }

  async function onRecorded(e) {
    recordOpen = false;
    const rec = e.detail;
    touched = true;
    showInfo($_('voice.saving'));
    let att;
    try {
      att = await uploadVoiceNote(rec);
    } catch (err) {
      // Keep the recording on this device and upload it when it can.
      try {
        if (!noteId) await enqueue(() => ensureNote());
        await queueVoiceNote(noteId, rec, { title, body_md: kind === 'text' ? body : '', kind, labels: noteLabels });
        showInfo($_('voice.saved_offline'));
      } catch {
        showError(err.message || $_('notes.save_failed'));
      }
      return;
    }
    attachments = [...attachments, att];
    await enqueue(async () => {
      if (!noteId) { await ensureNote(); return; }
      apply(await NoteApi.addAttachments(noteId, [att]));
    });
    if ($autoTranscribe && $extractSupport.transcribe) extractText(att, rec.blob);
  }

  /** Transcribe a voice note or read an image's text, then save it on the attachment. */
  async function extractText(att, blob = null) {
    if (extracting[att.uuid]) return;
    extracting = { ...extracting, [att.uuid]: true };
    try {
      let text, segments = null;
      if (isAudio(att)) ({ text, segments } = await transcribeVoiceNote(att, blob));
      else text = await readImageText(blob || await fetchAttachmentBlob(att.url));
      if (!text) { showInfo(isAudio(att) ? $_('trace_extract.no_speech') : $_('trace_extract.no_text')); return; }
      attachments = attachments.map(a => a.uuid === att.uuid ? { ...a, extracted_text: text, segments } : a);
      if (voiceFirst && isAudio(att)) {
        if (kind === 'text' && !body.trim() && !contentLocked) addTextToNote(text);
        if (!title.trim() && $traceReady) suggestTitle(text);
      }
      await enqueue(async () => {
        if (!noteId) return;
        await NoteApi.updateAttachment(noteId, att.uuid, isAudio(att) ? { extracted_text: text, segments } : { extracted_text: text });
      });
      // A long recording is the one nobody wants to read back, so it can get
      // its summary in the same pass when the setting is on.
      if (isAudio(att) && $autoSummarizeLong && (att.duration_ms || 0) >= AUTO_SUMMARY_MS && worthSummarizing(text)) {
        const { [att.uuid]: _t, ...others } = extracting;
        extracting = others;
        await summarizeVoice({ ...att, extracted_text: text });
      }
    } catch (err) {
      showError($_('trace_extract.failed', { values: { error: err.message || '' } }));
    } finally {
      const { [att.uuid]: _done, ...rest } = extracting;
      extracting = rest;
    }
  }

  /**
   * Summarise a voice note, transcribing first when there's nothing to work
   * from, so one press is enough on a recording Trace has never seen.
   */
  async function summarizeVoice(att, blob = null) {
    if (extracting[att.uuid]) return;
    const step = (s) => extracting = { ...extracting, [att.uuid]: s };
    step('summarizing');
    try {
      const { summary, text, segments } = await summarizeVoiceNote(att, blob, { onStep: step });
      if (!summary) { showInfo($_(text ? 'trace_extract.no_summary' : 'trace_extract.no_speech')); return; }
      attachments = attachments.map(a => a.uuid === att.uuid
        ? { ...a, summary, ...(text ? { extracted_text: text, segments } : {}) }
        : a);
      await enqueue(async () => {
        if (!noteId) return;
        await NoteApi.updateAttachment(noteId, att.uuid, text ? { summary, extracted_text: text, segments } : { summary });
      });
    } catch (err) {
      showError($_('trace_extract.failed', { values: { error: err.message || '' } }));
    } finally {
      const { [att.uuid]: _done, ...rest } = extracting;
      extracting = rest;
    }
  }

  /** A waveform measured for a recording saved without one. */
  function saveWaveform({ uuid, waveform }) {
    attachments = attachments.map(a => a.uuid === uuid ? { ...a, waveform } : a);
    if (contentLocked) return;
    // Queued, so a note still being created gets its id first.
    enqueue(async () => { if (noteId) await NoteApi.updateAttachment(noteId, uuid, { waveform }); });
  }

  /** Put a transcript or image text into the note: a paragraph, or checklist items. */
  function addTextToNote(text) {
    const clean = String(text || '').trim();
    if (!clean || contentLocked) return;
    viewerIndex = null;
    if (kind === 'checklist') {
      for (const line of clean.split('\n').map(l => l.trim()).filter(Boolean)) {
        onItemAdd({ detail: { uuid: crypto.randomUUID?.() || String(Math.random()), text: line, position: (items.at(-1)?.position || 0) + 1 } });
      }
      editorKey++;
      return;
    }
    body = body.trim() ? `${body.replace(/\s+$/, '')}\n\n${clean}` : clean;
    editorKey++;
    scheduleText();
  }

  // ── Images ────────────────────────────────────────────────────────
  async function addImages(fileList) {
    const files = [...(fileList || [])].filter(isImageFile);
    if (!files.length || contentLocked) return;
    touched = true;
    uploading += files.length;
    let result;
    try {
      result = await uploadNoteImages(files);
    } finally {
      uploading -= files.length;
    }
    if (result.failed) showError($_('attachments.upload_failed', { values: { count: result.failed } }));
    if (!result.attachments.length) return;
    attachments = [...attachments, ...result.attachments];
    await enqueue(async () => {
      if (!noteId) { await ensureNote(); return; }
      apply(await NoteApi.addAttachments(noteId, result.attachments));
    });
    if ($autoReadImages && $extractSupport.readImages) {
      for (const att of result.attachments) extractText(att);
    }
  }
  function removeImage(e) {
    const uuid = e.detail;
    touched = true;
    const gone = attachments.find(a => a.uuid === uuid);
    removedImages.add(uuid);
    attachments = attachments.filter(a => a.uuid !== uuid);
    enqueue(async () => {
      if (!noteId) return;
      apply(await NoteApi.deleteAttachment(noteId, uuid));
    });
    if (gone) showUndo($_(isAudio(gone) ? 'notes.undo_voice' : isFile(gone) ? 'files.undo_removed' : 'notes.undo_image'), () => restoreAttachment(gone));
  }
  function restoreAttachment(att) {
    touched = true;
    removedImages.delete(att.uuid);
    if (!attachments.some(a => a.uuid === att.uuid)) attachments = [...attachments, att];
    enqueue(async () => {
      if (!noteId) return;
      apply(await NoteApi.addAttachments(noteId, [att]));
      // The note keeps what was read or transcribed from it.
      if (att.extracted_text || att.waveform || att.segments || att.summary || att.preview_url) {
        await NoteApi.updateAttachment(noteId, att.uuid, {
          extracted_text: att.extracted_text ?? null, waveform: att.waveform ?? null, segments: att.segments ?? null,
          summary: att.summary ?? null, preview_url: att.preview_url ?? null,
        });
      }
    });
  }
  // Images and audio files, however they arrive (picker, paste, drop, share).
  function addFiles(fileList) {
    const files = [...(fileList || [])];
    const images = files.filter(isImageFile);
    const audio = files.filter(f => !isImageFile(f) && isAudioFile(f));
    const others = files.filter(f => !isImageFile(f) && !isAudioFile(f));
    if (images.length) addImages(images);
    if (audio.length) addAudioFiles(audio);
    if (others.length) addOtherFiles(others);
    return files.length;
  }

  // ── Files (any kind: PDFs, documents, archives, video) ─────────────
  $: fileAttachments = attachments.filter(isFile);
  let pendingFiles = [];          // shown as "Uploading" until they're stored
  let fileInput;
  let fileViewerIndex = null;
  function openFilePicker() { tick().then(() => fileInput?.click()); }

  async function addOtherFiles(files) {
    if (contentLocked) return;
    touched = true;
    for (const file of files) {
      const uuid = crypto.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
      const mime = file.type || 'application/octet-stream';
      pendingFiles = [...pendingFiles, { uuid, name: file.name, size_bytes: file.size, mime, pending: true }];
      let stored;
      try {
        stored = await NoteApi.uploadFile(file);
      } catch (err) {
        showError($_('files.upload_failed', { values: { name: file.name || '', error: err.message || '' } }));
        continue;
      } finally {
        pendingFiles = pendingFiles.filter(p => p.uuid !== uuid);
      }
      const att = { uuid, url: stored.url, mime: stored.mime || mime, name: file.name || null, size_bytes: stored.size ?? file.size ?? null };
      attachments = [...attachments, att];
      await enqueue(async () => {
        if (!noteId) { await ensureNote(); return; }
        apply(await NoteApi.addAttachments(noteId, [att]));
      });
      indexFile(att, file);
    }
  }

  /**
   * A PDF gets a picture of its first page for its chip, and a PDF's or a text
   * file's words go into search, the way a voice note's transcript does.
   */
  async function indexFile(att, file) {
    if (previewKind(att) === 'none' || previewKind(att) === 'video') return;
    extracting = { ...extracting, [att.uuid]: 'reading' };
    try {
      const patch = await fileIndexPatch(att, file, { uploadImage: (f) => NoteApi.uploadImage(f) });
      if (!Object.keys(patch).length) return;
      attachments = attachments.map(a => a.uuid === att.uuid ? { ...a, ...patch } : a);
      await enqueue(async () => {
        if (noteId) await NoteApi.updateAttachment(noteId, att.uuid, patch);
      });
    } finally {
      const { [att.uuid]: _done, ...rest } = extracting;
      extracting = rest;
    }
  }
  // ── Drawings ───────────────────────────────────────────────────────
  // A drawing is a picture on the note (the PNG every screen shows) that keeps
  // its strokes, so tapping it opens it again for editing.
  let drawingFor = null;          // { att, doc } while the drawing editor is open
  let drawingBusy = false;
  let drawFirst = false;          // opened as a new drawing note
  const isDrawing = (a) => !!(a?.is_drawing || a?.drawing);

  function newDrawing() {
    if (contentLocked) return;
    drawingFor = { att: null, doc: null };
  }
  async function openDrawing(att) {
    let doc = att.drawing || null;
    if (!doc && noteId) {
      try { doc = await NoteApi.getAttachmentDrawing(noteId, att.uuid); }
      catch (err) { showError($_('drawing.load_failed', { values: { error: err.message || '' } })); return; }
    }
    drawingFor = { att, doc };
  }
  function openImage(i) {
    const a = imageAttachments[i];
    if (isDrawing(a) && !contentLocked) openDrawing(a);
    else viewerIndex = i;
  }

  async function onDrawingDone(e) {
    const { drawing, changed } = e.detail;
    const target = drawingFor?.att || null;
    if (!changed) {
      drawingFor = null;
      if (drawFirst && !noteId && isEmptyNote({ title, body_md: body, items, attachments })) close();
      return;
    }
    if (!drawing.strokes.length) {
      drawingFor = null;
      if (target) removeImage({ detail: target.uuid });
      else if (drawFirst && !noteId && isEmptyNote({ title, body_md: body, items, attachments })) close();
      return;
    }
    drawingBusy = true;
    try {
      const { renderDrawingPng } = await import('../../lib/drawing-render.js');
      const png = await renderDrawingPng(drawing);
      const url = await NoteApi.uploadImage(new File([png.blob], 'drawing.png', { type: 'image/png' }));
      if (!url) throw new Error($_('notes.save_failed'));
      touched = true;
      const reread = $autoReadImages && $extractSupport.readImages;
      if (target) {
        const patch = { url, width: png.width, height: png.height, drawing, ...(reread ? {} : { extracted_text: null }) };
        const updated = { ...target, ...patch, mime: 'image/png', is_drawing: true };
        attachments = attachments.map(a => a.uuid === target.uuid ? updated : a);
        await enqueue(async () => {
          if (!noteId) { await ensureNote(); return; }
          await NoteApi.updateAttachment(noteId, target.uuid, patch);
        });
        if (reread) extractText(updated);
      } else {
        const att = { uuid: crypto.randomUUID?.() || `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`,
          url, mime: 'image/png', width: png.width, height: png.height, drawing, is_drawing: true };
        attachments = [...attachments, att];
        await enqueue(async () => {
          if (!noteId) { await ensureNote(); return; }
          apply(await NoteApi.addAttachments(noteId, [att]));
        });
        if (reread) extractText(att);
      }
      drawingFor = null;
    } catch (err) {
      showError($_('drawing.save_failed', { values: { error: err.message || '' } }));
    } finally {
      drawingBusy = false;
    }
  }

  function openFile(e) {
    const i = fileAttachments.findIndex(f => f.uuid === e.detail.uuid);
    if (i >= 0) fileViewerIndex = i;
  }
  // A recording that waited on this device went up while the note is open.
  function onVoiceUploaded(e) {
    const { noteId: id, att, blob } = e.detail || {};
    if (id == null || id !== noteId) return;
    e.detail.handled = true;
    if (!attachments.some(a => a.uuid === att.uuid)) attachments = [...attachments, att];
    touched = true;
    if ($autoTranscribe && $extractSupport.transcribe) extractText(att, blob);
  }
  $: pendingHere = $pendingVoice.filter(p => noteId != null && p.noteId === noteId);

  async function addAudioFiles(files) {
    if (contentLocked) return;
    touched = true;
    showInfo($_('voice.saving'));
    for (const file of files) {
      let att;
      try {
        att = await prepareAudioFile(file);
      } catch (err) {
        showError(err.message === 'unsupported' ? $_('voice.unsupported_file', { values: { name: file.name || '' } }) : (err.message || $_('notes.save_failed')));
        continue;
      }
      attachments = [...attachments, att];
      await enqueue(async () => {
        if (!noteId) { await ensureNote(); return; }
        apply(await NoteApi.addAttachments(noteId, [att]));
      });
      if ($autoTranscribe && $extractSupport.transcribe) extractText(att, att.mime === file.type ? file : null);
    }
  }
  function openAudioPicker() {
    recordOpen = false;
    tick().then(() => audioInput?.click());
  }
  let audioInput;

  function onPaste(e) {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length || contentLocked) return;
    e.preventDefault();
    addFiles(files);
  }
  function onDragOver(e) {
    if (contentLocked || ![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    dragOver = true;
  }
  function onDrop(e) {
    dragOver = false;
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length || contentLocked) return;
    e.preventDefault();
    addFiles(files);
  }

  // ── Trace actions ─────────────────────────────────────────────────
  async function openTrace(e) {
    traceAnchor = e.currentTarget.getBoundingClientRect();
    await flushAll();
    traceOpen = true;
  }
  // A Trace rewrite always leaves a restore point, however recent the last edit.
  async function applyTraceText(markdown) {
    traceOpen = false;
    touched = true;
    body = markdown;
    editorKey++;
    await enqueue(async () => {
      if (!noteId) { await ensureNote(); return; }
      apply(await NoteApi.updateNote(noteId, { title, body_md: body, snapshot: 'restore' }));
    });
  }
  async function applyTraceChecklist(lines) {
    traceOpen = false;
    await applyTraceText(lines.join('\n'));
    await convert();
  }

  // ── CookTrace shopping list ───────────────────────────────────────
  async function openCooktrace(e) {
    cookAnchor = e.currentTarget.getBoundingClientRect();
    await flushAll();
    cookOpen = true;
  }
  function onCooktraceSent(uuids) {
    cookOpen = false;
    if (!uuids.length || contentLocked) return;
    for (const uuid of uuids) onItemUpdate({ detail: { uuid, patch: { checked: true } } });
    editorKey++;
  }

  // ── Actions ───────────────────────────────────────────────────────
  function togglePin() { pinned = !pinned; patch({ pinned }); }
  function toggleInTasks() { inTasks = !inTasks; patch({ in_tasks: inTasks }); }
  $: canShowInTasks = kind === 'checklist' && !readOnly && !$tasksAllChecklists;
  function setColor(c) { color = c; patch({ color: c }); }
  function setLabels(ids) { noteLabels = ids; patch({ labels: ids }); }

  async function setReminder(detail) {
    reminderOpen = false;
    reminderAt = detail.reminder_at; reminderRepeat = detail.reminder_rrule; reminderTz = detail.reminder_tz;
    await ensureReminderPermission();
    await patch(detail);
    rescheduleReminders();
  }
  async function clearReminder() {
    reminderOpen = false;
    reminderAt = null; reminderRepeat = null; reminderTz = null;
    await patch({ reminder_at: null });
    rescheduleReminders();
  }
  function openReminder(e) {
    reminderAnchor = (e?.currentTarget || document.activeElement)?.getBoundingClientRect?.() || null;
    reminderOpen = true;
  }

  async function convert(undoing = false) {
    const next = kind === 'text' ? 'checklist' : 'text';
    const before = { kind, body, items: items.map(i => ({ ...i })) };
    checklistRef?.flush?.();
    await saveText();
    await enqueue(async () => {
      if (!noteId) {
        if (next === 'checklist') {
          items = String(body || '').split('\n').map(l => l.trim()).filter(Boolean)
            .map((line, i) => {
              const task = line.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
              const bare = line.replace(/^([-*+]|\d+[.)])\s+/, '');
              const struck = bare.match(/^~~(.+)~~$/);
              const text = task ? task[2] : struck ? struck[1] : bare;
              const checked = task ? task[1].toLowerCase() === 'x' : !!struck;
              return { uuid: crypto.randomUUID?.() || String(Date.now() + i), text, checked, position: i + 1 };
            });
          body = '';
        } else {
          body = items.map(i => `- [${i.checked ? 'x' : ' '}] ${i.text}`).join('\n');
          items = [];
        }
        kind = next;
        return;
      }
      const n = await NoteApi.convertNote(noteId, next);
      apply(n);
      kind = n.kind;
      body = n.body_md;
      items = (n.items || []).map(i => ({ ...i }));
    });
    editorKey++;
    if (!undoing) showUndo($_(next === 'checklist' ? 'notes.undo_to_checklist' : 'notes.undo_to_text'), () => undoConvert(before));
  }
  /** Convert back, then put the exact text or items from before back. */
  async function undoConvert(before) {
    await convert(true);
    touched = true;
    kind = before.kind;
    body = before.body;
    items = before.items;
    editorKey++;
    await enqueue(async () => {
      if (!noteId) return;
      if (before.kind === 'text') {
        apply(await NoteApi.updateNote(noteId, { body_md: before.body }));
      } else {
        const n = await NoteApi.getNote(noteId);
        for (const it of n.items || []) await NoteApi.deleteItem(noteId, it.uuid);
        for (const it of before.items) await NoteApi.addItem(noteId, { uuid: it.uuid, text: it.text, checked: it.checked, position: it.position, due_date: it.due_date || null });
        apply(await NoteApi.getNote(noteId));
      }
    });
  }

  async function archive() {
    await flushAll();
    const next = !archived;
    await patch({ archived: next });
    showInfo(next ? $_('notes.toast_archived') : $_('notes.toast_unarchived'));
    close();
  }

  async function trash() {
    await flushAll();
    if (noteId) {
      await enqueue(async () => apply(await NoteApi.trashNote(noteId)));
      showInfo($_('notes.toast_trashed'));
    }
    close(true);
  }

  async function restore() {
    await enqueue(async () => apply(await NoteApi.restoreNote(noteId)));
    showInfo($_('notes.toast_restored'));
  }

  async function deleteForever() {
    const ok = await confirmDialog({
      title: $_('notes.delete_forever_title'),
      message: $_('notes.delete_forever_message'),
      confirmText: $_('notes.delete_forever'),
      dangerous: true,
    });
    if (!ok) return;
    await enqueue(async () => { await NoteApi.deleteNoteForever(noteId); });
    close(true);
  }

  function onRestoredVersion(e) {
    const n = e.detail;
    apply(n);
    title = n.title; body = n.body_md; kind = n.kind;
    items = (n.items || []).map(i => ({ ...i }));
    editorKey++;
    showHistory = false;
  }

  async function flushAll() {
    checklistRef?.flush?.();
    if (textTimer) await saveText();
    await queue;
  }

  // ── Print and templates ───────────────────────────────────────────
  let printing = false;
  async function printThis() {
    if (printing) return;
    printing = true;
    try {
      await flushAll();
      await printNote(
        { title, body_md: body, kind, items, attachments, updated_at: updatedAt },
        { labels: chips.map(l => l.name), t: $_ },
      );
    } catch (err) {
      showError($_('print.failed'));
      console.warn('[print]', err);
    } finally {
      printing = false;
    }
  }

  async function saveAsTemplate() {
    const current = cleanTemplates($noteTemplates);
    if (current.length >= MAX_TEMPLATES) { showError($_('templates.too_many', { values: { n: MAX_TEMPLATES } })); return; }
    const name = await promptDialog({
      title: $_('templates.save_title'),
      message: $_('templates.save_message'),
      value: title.trim().slice(0, MAX_NAME),
      placeholder: $_('templates.name_placeholder'),
      maxlength: MAX_NAME,
      confirmText: $_('common.save'),
      cancelText: $_('common.cancel'),
    });
    if (!name) return;
    const template = templateFromNote({ title, body_md: body, kind, items, color }, name);
    if (!template) return;
    noteTemplates.set([...current, template]);
    showInfo($_('templates.saved', { values: { name: template.name } }));
  }

  let closing = false;
  async function close(skipDiscard = false, navigate = null) {
    if (closing) return;
    closing = true;
    await flushAll();
    const renamedFrom = openedTitle.trim();
    if (noteId && !trashed && !contentLocked && renamedFrom && title.trim() && renamedFrom !== title.trim()) {
      try { await NoteApi.updateNote(noteId, { title, rename_links_from: renamedFrom }); } catch { /* links can be fixed by hand */ }
    }
    // A note that ended up empty is removed instead of lingering as a blank card.
    if (!skipDiscard && noteId && !trashed && !hasPendingFor(noteId) && isEmptyNote({ title, body_md: body, items, attachments })) {
      try { await NoteApi.deleteNoteForever(noteId); } catch { /* best effort */ }
      noteId = null;
    }
    if (touched || skipDiscard) signalNotesChanged();
    refreshLabels();
    dispatch('close', { id: noteId, navigate });
  }

  // ── [[Links]] ─────────────────────────────────────────────────────
  let linkTitles = [];
  let backlinks = [];
  async function loadLinks() {
    try { linkTitles = (await NoteApi.getNoteTitles()).map(t => t.title); } catch { linkTitles = []; }
    if (noteId) {
      try { backlinks = await NoteApi.getBacklinks(noteId); } catch { backlinks = []; }
    }
  }
  function navigateTo(id) {
    if (id && id !== noteId) close(false, id);
  }
  async function openLinked(linkTitle) {
    await flushAll();
    const target = await NoteApi.findNoteByTitle(linkTitle).catch(() => null);
    if (target) { navigateTo(target.id); return; }
    const ok = await confirmDialog({
      title: $_('note_links.missing_title'),
      message: $_('note_links.missing_message', { values: { title: linkTitle } }),
      confirmText: $_('note_links.create'),
    });
    if (!ok) return;
    try {
      const created = await NoteApi.createNote({ title: linkTitle, body_md: '', kind: 'text' });
      navigateTo(created.id);
    } catch (e) {
      showError(e.message || $_('notes.save_failed'));
    }
  }

  function onKey(e) {
    // Ctrl/Cmd+Enter finishes the note, like the Done button.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !showHistory) { e.preventDefault(); close(); return; }
    // Ctrl/Cmd+P prints this note rather than the whole app screen.
    if ((e.key === 'p' || e.key === 'P') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) { e.preventDefault(); printThis(); return; }
    if (document.querySelector('.dialog-backdrop')) return;
    if (e.key === 'Escape' && viewerIndex == null && !colorOpen && !labelsOpen && !reminderOpen && !shareOpen && !traceOpen && !recordOpen && !cookOpen && !addOpen && !moreOpen) {
      e.preventDefault();
      if (showHistory) showHistory = false;
      else close();
    }
  }
  function onResize() { narrow = window.innerWidth < 600; }

  // ── Open and close from the card ──────────────────────────────────
  // Opened from a card, the editor grows out of it and shrinks back into
  // it on close. Without a visible card (new note, a linked note, reduced
  // motion) it rises into place instead.
  export let originId = null;
  /** Render in place (the List layout's side pane) instead of over the page. */
  export let inline = false;
  /** A quick voice note: start recording as soon as the editor opens. */
  export let autoRecord = false;
  /** Open straight into a new drawing (the + menu's Drawing). */
  export let autoDraw = false;
  // A narrow reading pane (a half-open foldable) keeps the main actions and moves the rest into More.
  let barW = 800;
  // A narrow editor card (beside a half-open fold) uses the phone's compact toolbar.
  let panelW = 0;
  $: compactBar = narrow || (!inline && panelW > 0 && panelW < 560);
  $: tightBar = inline && barW < 600;
  // The desktop editor's own bar (not the phone bar or the list pane's): what it shows stays out of the More menu.
  $: fullBar = !inline && !compactBar;
  /** Save anything pending, for switching notes in the side pane. */
  export async function flush() { await flushAll(); }
  /** The note's id once it exists (a new note gets one on its first save). */
  export function currentNoteId() { return noteId; }
  const _reduceMotion = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  function _cardRect() {
    const id = originId ?? noteId;
    if (id == null) return null;
    const el = document.querySelector(`.note-card[data-note-id="${id}"]:not(.drag-ghost)`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.bottom > 0 && r.top < window.innerHeight ? r : null;
  }
  function morph(node) {
    if (inline) return { duration: 0 };
    const from = !_reduceMotion && !$disableAnimations && originId != null ? _cardRect() : null;
    if (!from) return fly(node, { y: narrow ? 30 : 16, duration: $disableAnimations ? 0 : 220, easing: cubicOut });
    const to = node.getBoundingClientRect();
    const sx = from.width / to.width, sy = from.height / to.height;
    const dx = from.left - to.left, dy = from.top - to.top;
    return {
      duration: 300,
      easing: cubicOut,
      css: (t, u) => `transform-origin: 0 0; transform: translate(${dx * u}px, ${dy * u}px) scale(${1 + (sx - 1) * u}, ${1 + (sy - 1) * u}); opacity: ${Math.min(1, 0.25 + t * 1.5)};`,
    };
  }

  // Note-level commands typed as /checklist, /image, /file, /voice, /reminder.
  function onSlash(key) {
    const rect = document.querySelector('.editor-panel .tiptap-host')?.getBoundingClientRect() || null;
    const fake = { currentTarget: { getBoundingClientRect: () => rect } };
    if (key === 'checklist') convert();
    else if (key === 'image') imageInput.click();
    else if (key === 'file') openFilePicker();
    else if (key === 'drawing') newDrawing();
    else if (key === 'voice') openRecorder(fake);
    else if (key === 'reminder') { reminderAnchor = rect; reminderOpen = true; }
  }

  // ── Phone editor bar ──────────────────────────────────────────────
  // On a phone the bar sits on top of the on-screen keyboard (the visual
  // viewport shrinks while it's up; the Android app resizes the WebView
  // itself, so this stays 0 there), holds a short row of actions, and
  // tucks the rest into Add and More sheets.
  let kb = 0;
  function onViewport() {
    const vv = window.visualViewport;
    kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
  }
  let addOpen = false, moreOpen = false, addAnchor = null, moreAnchor = null;
  let fmtMode = false;
  let formats = {};
  $: fmtTools = bodyRef?.formatTools?.() || [];
  $: if (kind !== 'text' || contentLocked) fmtMode = false;
  function openAdd(e) { addAnchor = e.currentTarget.getBoundingClientRect(); addOpen = true; }
  function openMore(e) { moreAnchor = e.currentTarget.getBoundingClientRect(); moreOpen = true; }
  // Run a sheet item once its sheet has closed, anchored where the sheet's button was.
  function fromSheet(fn, anchorRect) {
    addOpen = false; moreOpen = false;
    const fake = { currentTarget: { getBoundingClientRect: () => anchorRect } };
    tick().then(() => fn(fake));
  }

  onMount(async () => {
    if (autoRecord && canRecord && !noteId) startQuickVoice();
    if (autoDraw && !noteId && !contentLocked) { drawFirst = true; newDrawing(); }
    loadLinks();
    loadCooktraceLink();
    window.addEventListener('keydown', onKey);
    window.addEventListener('note:voice-uploaded', onVoiceUploaded);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onViewport);
    window.visualViewport?.addEventListener('scroll', onViewport);
    await tick();
    if (!noteId) {
      if (prefill?.title || prefill?.body_md || prefill?.items?.length) scheduleText(); // shared or template content saves without needing an edit
      if (prefill?.images?.length) addFiles(prefill.images);
      else if (kind === 'text' && !voiceFirst) titleEl?.focus();
    }
  });
  onDestroy(() => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('note:voice-uploaded', onVoiceUploaded);
    window.removeEventListener('resize', onResize);
    window.visualViewport?.removeEventListener('resize', onViewport);
    window.visualViewport?.removeEventListener('scroll', onViewport);
    clearTimeout(textTimer);
  });

  function openColor(e) { colorAnchor = e.currentTarget.getBoundingClientRect(); colorOpen = true; }
  function openLabels(e) { labelsAnchor = e.currentTarget.getBoundingClientRect(); labelsOpen = true; }
  async function openShare(e) {
    shareAnchor = e.currentTarget.getBoundingClientRect();
    await flushAll();
    if (!noteId) {
      if (isEmptyNote({ title, body_md: body, items, attachments })) { showInfo($_('sharing.empty_note')); return; }
      await enqueue(ensureNote);
    }
    shareOpen = true;
  }
  function onLeft() {
    shareOpen = false;
    signalNotesChanged();
    dispatch('close', { id: null });
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events -->
<!-- svelte-ignore a11y-no-static-element-interactions -->
<!-- The host stays in place while the backdrop moves to <body>. Without a fixed
     first node, closing the editor left its other top-level nodes behind. -->
<div class="editor-host">
<div use:portal={!inline} class="editor-backdrop" class:inline on:click|self={() => { if (!inline) close(); }} transition:fade|global={{ duration: $disableAnimations || inline ? 0 : 160 }}>
  <div class="editor-panel" class:inline class:narrow class:compact-bar={compactBar} bind:clientWidth={panelW} class:kb-open={narrow && kb > 0} class:drag-over={dragOver} style="{noteColorStyle(color)} --kb:{narrow ? kb : 0}px"
    on:paste={onPaste} on:dragover={onDragOver} on:dragleave={() => dragOver = false} on:drop={onDrop}
    role={inline ? 'region' : 'dialog'} aria-modal={inline ? undefined : 'true'} aria-label={title || $_('notes.untitled')}
    tabindex="-1" use:dialogFocus={{ disabled: inline, autofocus: false }}
    in:morph|global out:morph|global>

    {#if showHistory && noteId}
      <div class="editor-scroll">
        <VersionHistory {noteId} canRestore={!contentLocked} on:close={() => showHistory = false} on:restored={onRestoredVersion} />
      </div>
    {:else}
      {#if inline && !readOnly}
        <div class="reader-bar" class:tight={barW < 600} bind:clientWidth={barW} role="toolbar" aria-label={$_('notes.more_options')}>
          <span class="crumb" title={crumb}>
            {#if chips.length && chips[0].icon}
              <LabelGlyph label={chips[0]} iconSize={17} />
            {:else}
              <span class="material-symbols-rounded">{chips.length ? 'label' : archived ? 'archive' : 'sticky_note_2'}</span>
            {/if}
            <span class="crumb-text">{crumb}</span>
          </span>
          <span class="edited" aria-live="polite">
            {#if saving}{$_('notes.saving')}{:else if updatedAt}{$_('notes.edited', { values: { when: relativeTime(updatedAt).toLowerCase() } })}{/if}
          </span>
          <span class="spacer"></span>
          <button class="icon-btn" class:on={pinned} on:click={togglePin}
            title={pinned ? $_('notes.unpin') : $_('notes.pin')} aria-label={pinned ? $_('notes.unpin') : $_('notes.pin')} aria-pressed={pinned}>
            <span class="material-symbols-rounded" class:fill={pinned}>keep</span>
          </button>
          {#if isOwner}
            <button class="icon-btn" on:click={openReminder} title={$_('reminders.remind_me')} aria-label={$_('reminders.remind_me')}>
              <span class="material-symbols-rounded">notification_add</span>
            </button>
          {/if}
          {#if $sharingAvailable && !tightBar}
            <button class="icon-btn" on:click={openShare} title={$_('sharing.share')} aria-label={$_('sharing.share')}>
              <span class="material-symbols-rounded">person_add</span>
            </button>
          {/if}
          {#if !contentLocked && !tightBar}
            <button class="icon-btn" on:click={() => imageInput.click()} title={$_('attachments.add_image')} aria-label={$_('attachments.add_image')}>
              <span class="material-symbols-rounded">add_photo_alternate</span>
            </button>
            <button class="icon-btn" on:click={openFilePicker} title={$_('files.attach')} aria-label={$_('files.attach')}>
              <span class="material-symbols-rounded">attach_file</span>
            </button>
            <button class="icon-btn" on:click={newDrawing} title={$_('drawing.new')} aria-label={$_('drawing.new')}>
              <span class="material-symbols-rounded">draw</span>
            </button>
            {#if canRecord}
              <button class="icon-btn" data-record on:click={openRecorder} title={$_('voice.record')} aria-label={$_('voice.record')}>
                <span class="material-symbols-rounded">mic</span>
              </button>
            {/if}
            <button class="icon-btn" on:click={openColor} title={$_('notes.color')} aria-label={$_('notes.color')}>
              <span class="material-symbols-rounded">palette</span>
            </button>
          {/if}
          {#if !tightBar}
            <button class="icon-btn" on:click={openLabels} title={$_('notes.labels')} aria-label={$_('notes.labels')}>
              <span class="material-symbols-rounded">label</span>
            </button>
          {/if}
          <button class="icon-btn" on:click={openMore} title={$_('notes.more_options')} aria-label={$_('notes.more_options')} aria-haspopup="menu">
            <span class="material-symbols-rounded">more_horiz</span>
          </button>
          <span class="bar-sep" aria-hidden="true"></span>
          <button class="icon-btn" on:click={() => close()} title={$_('common.close')} aria-label={$_('common.close')}>
            <span class="material-symbols-rounded">close</span>
          </button>
        </div>
      {/if}
      <div class="editor-top">
        {#if narrow}
          <button class="icon-btn" on:click={() => close()} aria-label={$_('common.back')}>
            <span class="material-symbols-rounded">arrow_back</span>
          </button>
        {/if}
        <!-- svelte-ignore a11y-autofocus -->
        <input
          class="title-input"
          bind:this={titleEl}
          bind:value={title}
          placeholder={$_('notes.title_placeholder')}
          readonly={contentLocked}
          maxlength="1000"
          on:input={scheduleText}
          on:keydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); kind === 'text' ? bodyRef?.focus() : null; } }}
        />
        {#if !readOnly && !inline}
          <button class="icon-btn" class:on={pinned} on:click={togglePin}
            title={pinned ? $_('notes.unpin') : $_('notes.pin')} aria-label={pinned ? $_('notes.unpin') : $_('notes.pin')} aria-pressed={pinned}>
            <span class="material-symbols-rounded" class:fill={pinned}>keep</span>
          </button>
        {/if}
      </div>

      <div class="editor-scroll">
        {#if imageAttachments.length || uploading}
          <div class="editor-images">
            <AttachmentGrid attachments={imageAttachments} pending={uploading} editable={!contentLocked}
              on:open={(e) => openImage(e.detail)} on:remove={removeImage} />
          </div>
        {/if}
        {#if pendingHere.length}
          <ul class="pending-voice" aria-live="polite">
            {#each pendingHere as p (p.id)}
              <li>
                <span class="material-symbols-rounded">cloud_upload</span>
                <span class="pv-text">{$_('voice.waiting_upload', { values: { length: formatDuration(p.durationMs) } })}</span>
                <button class="pv-btn" on:click={() => flushPendingVoice()}>{$_('voice.retry')}</button>
                <button class="pv-btn danger" on:click={async () => { if (await confirmDialog({ title: $_('voice.discard_title'), message: $_('voice.discard_message'), confirmText: $_('voice.cancel'), dangerous: true })) discardPendingVoice(p.id); }}>{$_('voice.cancel')}</button>
              </li>
            {/each}
          </ul>
        {/if}
        <VoiceNotes notes={voiceNotes} editable={!contentLocked} canTranscribe={$extractSupport.transcribe}
          canSummarize={$extractSupport.transcribe && $traceReady} busy={extracting}
          on:remove={removeImage} on:transcribe={(e) => extractText(e.detail)} on:addtext={(e) => addTextToNote(e.detail)}
          on:summarize={(e) => summarizeVoice(e.detail)}
          on:waveform={(e) => saveWaveform(e.detail)} />
        <FileAttachments files={[...fileAttachments, ...pendingFiles]} editable={!contentLocked} busy={extracting}
          on:open={openFile} on:remove={removeImage} />
        {#key editorKey}
          {#if kind === 'text'}
            <TipTapEditor bind:this={bodyRef} bind:value={body} editable={!contentLocked} showToolbar={!narrow}
              on:formats={(e) => formats = e.detail}
              slashActions={contentLocked ? [] : ['checklist', 'image', 'file', 'drawing', ...(canRecord ? ['voice'] : []), ...(isOwner ? ['reminder'] : [])]}
              on:slash={(e) => onSlash(e.detail)}
              linkTitles={linkTitles.filter(t => t.toLowerCase() !== title.trim().toLowerCase())}
              placeholder={$_('notes.body_placeholder')} on:change={scheduleText} on:openlink={(e) => openLinked(e.detail)} />
          {:else}
            <ChecklistEditor bind:this={checklistRef} {items} editable={!contentLocked}
              on:add={onItemAdd} on:update={onItemUpdate} on:delete={onItemDelete} on:reorder={onItemReorder} />
          {/if}
        {/key}

        {#if chips.length || reminderAt || shared}
          <div class="editor-chips">
            {#if shared}
              <button class="chip chip-share" on:click={openShare} disabled={!$sharingAvailable}>
                <span class="material-symbols-rounded">group</span>
                {shareRole === 'owner'
                  ? $_('sharing.shared_with', { values: { count: shareCount } })
                  : $_('sharing.shared_by', { values: { name: shareOwner || '' } })}
                {#if shareRole === 'view'}<span class="chip-sub">{$_('sharing.can_view')}</span>{/if}
              </button>
            {/if}
            {#if reminderAt}
              <ReminderChip note={reminderNote} size="md" clickable={!readOnly && isOwner} removable={!readOnly && isOwner}
                on:edit={openReminder} on:clear={clearReminder} />
            {/if}
            {#each chips as l (l.id)}
              <span class="chip">
                <span class="chip-dot" style="background:{colorDot(l.color)}"></span>{l.name}
                {#if !readOnly}
                  <button class="chip-x" aria-label={$_('notes.remove_label', { values: { name: l.name } })}
                    on:click={() => setLabels(noteLabels.filter(id => id !== l.id))}>
                    <span class="material-symbols-rounded">close</span>
                  </button>
                {/if}
              </span>
            {/each}
          </div>
        {/if}

        {#if backlinks.length}
          <section class="backlinks" aria-label={$_('note_links.linked_from')}>
            <h3>{$_('note_links.linked_from')}</h3>
            <div class="backlink-list">
              {#each backlinks as b (b.id)}
                <button class="chip backlink" on:click={() => navigateTo(b.id)}>
                  <span class="material-symbols-rounded">{b.kind === 'checklist' ? 'checklist' : 'description'}</span>
                  {b.title || $_('notes.untitled')}
                </button>
              {/each}
            </div>
          </section>
        {/if}
      </div>

      {#if !inline || readOnly}
      <footer class="editor-bar">
        {#if readOnly}
          <span class="edited">{$_('notes.in_trash')}</span>
          <span class="spacer"></span>
          <button class="btn btn-secondary" on:click={restore}>
            <span class="material-symbols-rounded">restore_from_trash</span>{$_('notes.restore')}
          </button>
          <button class="btn btn-danger" on:click={deleteForever}>{$_('notes.delete_forever')}</button>
        {:else if compactBar && fmtMode}
          <div class="phone-bar fmt-row" role="toolbar" aria-label={$_('notes.formatting')}>
            <button class="icon-btn" on:mousedown|preventDefault on:click={() => fmtMode = false} aria-label={$_('notes.close_formatting')}>
              <span class="material-symbols-rounded">close</span>
            </button>
            <div class="fmt-scroll">
              {#each fmtTools as t (t.key)}
                <button class="icon-btn" class:on={formats[t.key]} aria-pressed={!!formats[t.key]} aria-label={$_(t.label)}
                  on:mousedown|preventDefault on:click={() => bodyRef?.format(t.key)}>
                  <span class="material-symbols-rounded">{t.icon}</span>
                </button>
              {/each}
            </div>
          </div>
        {:else if compactBar}
          <div class="phone-bar">
            {#if !contentLocked}
              <button class="icon-btn" on:mousedown|preventDefault on:click={openAdd} aria-label={$_('notes.add_to_note')} title={$_('notes.add_to_note')}>
                <span class="material-symbols-rounded">add_box</span>
              </button>
              {#if kind === 'text'}
                <button class="icon-btn" on:mousedown|preventDefault on:click={() => fmtMode = true} aria-label={$_('notes.formatting')} title={$_('notes.formatting')}>
                  <span class="material-symbols-rounded">text_format</span>
                </button>
                <button class="icon-btn" class:on={formats.todo} aria-pressed={!!formats.todo} on:mousedown|preventDefault on:click={() => bodyRef?.format('todo')}
                  aria-label={$_('notes.fmt_checkboxes')} title={$_('notes.fmt_checkboxes')}>
                  <span class="material-symbols-rounded">check_box</span>
                </button>
              {/if}
              {#if canRecord}
                <button class="icon-btn" data-record on:mousedown|preventDefault on:click={openRecorder} aria-label={$_('voice.record')} title={$_('voice.record')}>
                  <span class="material-symbols-rounded">mic</span>
                </button>
              {/if}
              <button class="icon-btn" on:mousedown|preventDefault on:click={openColor} aria-label={$_('notes.color')} title={$_('notes.color')}>
                <span class="material-symbols-rounded">palette</span>
              </button>
            {/if}
            {#if isOwner}
              <button class="icon-btn" on:mousedown|preventDefault on:click={openReminder} aria-label={$_('reminders.remind_me')} title={$_('reminders.remind_me')}>
                <span class="material-symbols-rounded">notification_add</span>
              </button>
            {/if}
            <span class="spacer"></span>
            <span class="edited phone-edited" aria-live="polite">
              {#if saving}{$_('notes.saving')}{:else if updatedAt}{$_('notes.edited', { values: { when: relativeTime(updatedAt).toLowerCase() } })}{/if}
            </span>
            <button class="icon-btn" on:mousedown|preventDefault on:click={openMore} aria-label={$_('notes.more_options')} title={$_('notes.more_options')}>
              <span class="material-symbols-rounded">more_vert</span>
            </button>
          </div>
        {:else}
          <div class="bar-actions">
            {#if isOwner}
              <button class="icon-btn" on:click={openReminder} title={$_('reminders.remind_me')} aria-label={$_('reminders.remind_me')}>
                <span class="material-symbols-rounded">notification_add</span>
              </button>
            {/if}
            {#if $traceReady && kind === 'text' && !contentLocked && body.trim()}
              <button class="icon-btn trace-btn" on:click={openTrace} title={$_('trace_actions.title')} aria-label={$_('trace_actions.title')}>
                <span class="material-symbols-rounded">auto_awesome</span>
              </button>
            {/if}
            {#if cooktraceOn($cooktraceLink) && kind === 'checklist'}
              <button class="icon-btn" on:click={openCooktrace} title={$_('cooktrace.send')} aria-label={$_('cooktrace.send')}>
                <span class="material-symbols-rounded">add_shopping_cart</span>
              </button>
            {/if}
            {#if $sharingAvailable}
              <button class="icon-btn" on:click={openShare} title={$_('sharing.share')} aria-label={$_('sharing.share')}>
                <span class="material-symbols-rounded">person_add</span>
              </button>
            {/if}
            {#if !contentLocked}
              <button class="icon-btn" on:click={() => imageInput.click()} title={$_('attachments.add_image')} aria-label={$_('attachments.add_image')}>
                <span class="material-symbols-rounded">add_photo_alternate</span>
              </button>
              <button class="icon-btn" on:click={openFilePicker} title={$_('files.attach')} aria-label={$_('files.attach')}>
                <span class="material-symbols-rounded">attach_file</span>
              </button>
              <button class="icon-btn" on:click={newDrawing} title={$_('drawing.new')} aria-label={$_('drawing.new')}>
                <span class="material-symbols-rounded">draw</span>
              </button>
              {#if canRecord}
                <button class="icon-btn" data-record on:click={openRecorder} title={$_('voice.record')} aria-label={$_('voice.record')}>
                  <span class="material-symbols-rounded">mic</span>
                </button>
              {/if}
              <button class="icon-btn" on:click={openColor} title={$_('notes.color')} aria-label={$_('notes.color')}>
                <span class="material-symbols-rounded">palette</span>
              </button>
            {/if}
            <button class="icon-btn" on:click={openLabels} title={$_('notes.labels')} aria-label={$_('notes.labels')}>
              <span class="material-symbols-rounded">label</span>
            </button>
            {#if canShowInTasks}
              <button class="icon-btn" class:on={inTasks} on:click={toggleInTasks} aria-pressed={inTasks}
                title={inTasks ? $_('tasks.shown_in_tasks') : $_('tasks.show_in_tasks')} aria-label={$_('tasks.show_in_tasks')}>
                <span class="material-symbols-rounded" class:fill={inTasks}>task_alt</span>
              </button>
            {/if}
            {#if !contentLocked}
              <button class="icon-btn" on:click={() => convert()}
                title={kind === 'text' ? $_('notes.to_checklist') : $_('notes.to_text')}
                aria-label={kind === 'text' ? $_('notes.to_checklist') : $_('notes.to_text')}>
                <span class="material-symbols-rounded">{kind === 'text' ? 'checklist' : 'notes'}</span>
              </button>
            {/if}
            <button class="icon-btn" on:click={openMore} title={$_('notes.more_options')} aria-label={$_('notes.more_options')} aria-haspopup="menu">
              <span class="material-symbols-rounded">more_vert</span>
            </button>
          </div>
          <span class="spacer"></span>
          <span class="edited" aria-live="polite">
            {#if saving}{$_('notes.saving')}{:else if updatedAt}{$_('notes.edited', { values: { when: relativeTime(updatedAt).toLowerCase() } })}{/if}
          </span>
          {#if !narrow}
            <button class="btn btn-primary done" on:click={() => close()}>{$_('notes.done')}</button>
          {/if}
        {/if}
      </footer>
      {/if}
    {/if}
  </div>
</div>

<input bind:this={imageInput} class="note-image-input" type="file" accept="image/*" multiple hidden
  on:change={(e) => { addImages(e.target.files); e.target.value = ''; }} />
<input bind:this={audioInput} class="note-audio-input" type="file" multiple hidden
  accept="audio/*,.m4a,.mp3,.wav,.ogg,.opus,.webm,.flac,.aac,.amr,.3gp"
  on:change={(e) => { addAudioFiles([...e.target.files]); e.target.value = ''; }} />
<input bind:this={fileInput} class="note-file-input" type="file" multiple hidden
  on:change={(e) => { addFiles([...e.target.files]); e.target.value = ''; }} />
{#if drawingFor}
  <DrawingEditor drawing={drawingFor.doc} busy={drawingBusy} on:done={onDrawingDone} />
{/if}
{#if fileViewerIndex != null}
  <FileViewer files={fileAttachments} index={fileViewerIndex} on:close={() => fileViewerIndex = null} />
{/if}
{#if viewerIndex != null}
  <ImageViewer attachments={imageAttachments} index={viewerIndex} canRead={$extractSupport.readImages && !contentLocked}
    canAdd={!contentLocked} busy={extracting}
    on:read={(e) => extractText(e.detail)} on:addtext={(e) => addTextToNote(e.detail)} on:close={() => viewerIndex = null} />
{/if}

<Popover bind:open={addOpen} anchor={addAnchor} label={$_('notes.add_to_note')}>
  <div class="sheet-menu">
    <button class="sheet-item" on:click={() => fromSheet(() => imageInput.click(), addAnchor)}>
      <span class="material-symbols-rounded">add_photo_alternate</span>{$_('attachments.add_image')}
    </button>
    <button class="sheet-item" on:click={() => { addOpen = false; openFilePicker(); }}>
      <span class="material-symbols-rounded">attach_file</span>{$_('files.attach')}
    </button>
    <button class="sheet-item" on:click={() => { addOpen = false; newDrawing(); }}>
      <span class="material-symbols-rounded">draw</span>{$_('drawing.new')}
    </button>
    {#if canRecord}
      <button class="sheet-item" on:click={() => fromSheet(openRecorder, addAnchor)}>
        <span class="material-symbols-rounded">mic</span>{$_('voice.record')}
      </button>
    {/if}
    <button class="sheet-item" on:click={() => { addOpen = false; tick().then(() => audioInput?.click()); }}>
      <span class="material-symbols-rounded">audio_file</span>{$_('voice.add_file')}
    </button>
    <button class="sheet-item" on:click={() => fromSheet(() => convert(), addAnchor)}>
      <span class="material-symbols-rounded">{kind === 'text' ? 'checklist' : 'notes'}</span>{kind === 'text' ? $_('notes.to_checklist') : $_('notes.to_text')}
    </button>
  </div>
</Popover>
<Popover bind:open={moreOpen} anchor={moreAnchor} label={$_('notes.more_options')}>
  <div class="sheet-menu">
    {#if canShowInTasks && !fullBar}
      <button class="sheet-item" role="menuitemcheckbox" aria-checked={inTasks} on:click={() => { toggleInTasks(); moreOpen = false; }}>
        <span class="material-symbols-rounded" class:fill={inTasks}>task_alt</span>{$_('tasks.show_in_tasks')}
        {#if inTasks}<span class="material-symbols-rounded sheet-check">check</span>{/if}
      </button>
    {/if}
    {#if inline}
      {#if tightBar}
        {#if !contentLocked}
          <button class="sheet-item" on:click={() => fromSheet(() => imageInput.click(), moreAnchor)}>
            <span class="material-symbols-rounded">add_photo_alternate</span>{$_('attachments.add_image')}
          </button>
          <button class="sheet-item" on:click={() => { moreOpen = false; openFilePicker(); }}>
            <span class="material-symbols-rounded">attach_file</span>{$_('files.attach')}
          </button>
          <button class="sheet-item" on:click={() => { moreOpen = false; newDrawing(); }}>
            <span class="material-symbols-rounded">draw</span>{$_('drawing.new')}
          </button>
          {#if canRecord}
            <button class="sheet-item" on:click={() => fromSheet(openRecorder, moreAnchor)}>
              <span class="material-symbols-rounded">mic</span>{$_('voice.record')}
            </button>
          {/if}
          <button class="sheet-item" on:click={() => fromSheet(openColor, moreAnchor)}>
            <span class="material-symbols-rounded">palette</span>{$_('notes.color')}
          </button>
        {/if}
        <button class="sheet-item" on:click={() => fromSheet(openLabels, moreAnchor)}>
          <span class="material-symbols-rounded">label</span>{$_('notes.labels')}
        </button>
        {#if $sharingAvailable}
          <button class="sheet-item" on:click={() => fromSheet(openShare, moreAnchor)}>
            <span class="material-symbols-rounded">person_add</span>{$_('sharing.share')}
          </button>
        {/if}
      {/if}
      {#if !contentLocked}
        <button class="sheet-item" on:click={() => fromSheet(() => convert(), moreAnchor)}>
          <span class="material-symbols-rounded">{kind === 'text' ? 'checklist' : 'notes'}</span>{kind === 'text' ? $_('notes.to_checklist') : $_('notes.to_text')}
        </button>
      {/if}
    {:else if !fullBar}
    <button class="sheet-item" on:click={() => fromSheet(openLabels, moreAnchor)}>
      <span class="material-symbols-rounded">label</span>{$_('notes.labels')}
    </button>
    {/if}
    {#if $sharingAvailable && !inline && !fullBar}
      <button class="sheet-item" on:click={() => fromSheet(openShare, moreAnchor)}>
        <span class="material-symbols-rounded">person_add</span>{$_('sharing.share')}
      </button>
    {/if}
    {#if $traceReady && kind === 'text' && !contentLocked && body.trim() && !fullBar}
      <button class="sheet-item" on:click={() => fromSheet(openTrace, moreAnchor)}>
        <span class="material-symbols-rounded">auto_awesome</span>{$_('trace_actions.title')}
      </button>
    {/if}
    {#if cooktraceOn($cooktraceLink) && kind === 'checklist' && !fullBar}
      <button class="sheet-item" on:click={() => fromSheet(openCooktrace, moreAnchor)}>
        <span class="material-symbols-rounded">add_shopping_cart</span>{$_('cooktrace.send')}
      </button>
    {/if}
    <button class="sheet-item" on:click={() => fromSheet(archive, moreAnchor)}>
      <span class="material-symbols-rounded">{archived ? 'unarchive' : 'archive'}</span>{archived ? $_('notes.unarchive') : $_('notes.archive')}
    </button>
    <button class="sheet-item" on:click={() => fromSheet(printThis, moreAnchor)}>
      <span class="material-symbols-rounded">print</span>{$_('print.print')}
    </button>
    {#if canTemplate({ title, body_md: body, kind, items })}
      <button class="sheet-item" on:click={() => fromSheet(saveAsTemplate, moreAnchor)}>
        <span class="material-symbols-rounded">note_stack_add</span>{$_('templates.save_as')}
      </button>
    {/if}
    {#if noteId}
      <button class="sheet-item" on:click={() => fromSheet(async () => { await flushAll(); showHistory = true; }, moreAnchor)}>
        <span class="material-symbols-rounded">history</span>{$_('notes.version_history')}
      </button>
    {/if}
    {#if isOwner}
      <button class="sheet-item danger" on:click={() => fromSheet(trash, moreAnchor)}>
        <span class="material-symbols-rounded">delete</span>{$_('notes.move_to_trash')}
      </button>
    {/if}
  </div>
</Popover>
<Popover bind:open={colorOpen} anchor={colorAnchor} label={$_('notes.color')}>
  <ColorPalette value={color} on:select={(e) => { setColor(e.detail); colorOpen = false; }} />
</Popover>
<Popover bind:open={reminderOpen} anchor={reminderAnchor} label={$_('reminders.remind_me')}>
  <ReminderPicker reminderAt={reminderAt} repeat={reminderRepeat} tz={reminderTz}
    on:set={(e) => setReminder(e.detail)} on:clear={clearReminder} />
</Popover>
<Popover bind:open={recordOpen} anchor={recordAnchor} label={$_('voice.record')}>
  {#if recordOpen}
    <VoiceRecorder canAddFile={!contentLocked} on:done={onRecorded} on:cancel={onRecordCancel} on:file={openAudioPicker} />
  {/if}
</Popover>
<Popover bind:open={traceOpen} anchor={traceAnchor} label={$_('trace_actions.title')}>
  {#if traceOpen}
    <TraceActions {title} {body}
      on:replace={(e) => applyTraceText(e.detail.markdown)}
      on:prepend={(e) => applyTraceText(`${e.detail.markdown}\n\n${body}`)}
      on:checklist={(e) => applyTraceChecklist(e.detail.items)}
      on:close={() => traceOpen = false} />
  {/if}
</Popover>
<Popover bind:open={cookOpen} anchor={cookAnchor} label={$_('cooktrace.send')}>
  {#if cookOpen}
    <CooktraceSend {items} canCheck={!contentLocked} on:sent={(e) => onCooktraceSent(e.detail.uuids)} on:close={() => cookOpen = false} />
  {/if}
</Popover>
<Popover bind:open={shareOpen} anchor={shareAnchor} label={$_('sharing.share')}>
  {#if shareOpen && noteId}
    <ShareDialog {noteId} on:changed={(e) => { shareCount = e.detail.count; touched = true; }} on:left={onLeft} />
  {/if}
</Popover>
<Popover bind:open={labelsOpen} anchor={labelsAnchor} label={$_('notes.labels')}>
  <LabelPicker selected={noteLabels} on:change={(e) => setLabels(e.detail)} />
</Popover>
</div>

<style>
  .editor-host { display: contents; }
  .editor-images { margin-bottom: 14px; }
  .pending-voice { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .pending-voice li {
    display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--warning, #ffb547) 12%, transparent); color: var(--text-1); font-size: 13.5px;
  }
  .pending-voice .material-symbols-rounded { color: var(--warning, #ffb547); font-size: 20px; }
  .pv-text { flex: 1; min-width: 0; }
  .pv-btn { padding: 4px 8px; border-radius: 8px; font-size: 13px; color: var(--accent); }
  .pv-btn:hover { background: var(--accent-dim); }
  .pv-btn.danger { color: var(--text-3); }
  .backlinks { margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--note-border, var(--border)); }
  .backlinks h3 { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); margin-bottom: 8px; }
  .backlink-list { display: flex; flex-wrap: wrap; gap: 6px; }
  .backlink { padding: 0 12px 0 9px; cursor: pointer; }
  .backlink:hover { background: color-mix(in srgb, var(--text-1) 11%, transparent); color: var(--text-1); }
  .backlink .material-symbols-rounded { font-size: 16px; }
  .editor-panel.drag-over { outline: 2px dashed var(--accent); outline-offset: -6px; }

  .editor-backdrop.inline { display: contents; }
  /* In the List layout's reading pane: flush, with its toolbar on top. */
  .editor-panel.inline {
    max-width: none; max-height: none; height: 100%; flex: 1;
    border: none; border-radius: 0; box-shadow: none;
  }
  .reader-bar {
    display: flex; align-items: center; gap: 2px; flex-shrink: 0;
    height: 58px; padding: 0 12px 0 32px;
    border-bottom: 1px solid var(--note-border);
  }
  .crumb { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font-size: 13px; font-weight: 600; color: var(--text-2); }
  .crumb .material-symbols-rounded { font-size: 17px; color: var(--note-glow, var(--accent)); }
  .crumb-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .reader-bar .edited { margin-left: 12px; overflow: hidden; text-overflow: ellipsis; }
  .reader-bar .icon-btn { width: 36px; height: 36px; border-radius: 10px; }
  .reader-bar .icon-btn .material-symbols-rounded { font-size: 21px; }
  .bar-sep { width: 1px; height: 22px; background: var(--note-border); margin: 0 6px; }
  .inline .editor-top { padding-top: 26px; }
  @media (max-width: 1320px) { .reader-bar .edited { display: none; } }
  .reader-bar.tight { padding-left: 20px; }
  .reader-bar.tight .crumb { flex-shrink: 1; }
  .editor-backdrop {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(20px) saturate(160%);
    -webkit-backdrop-filter: blur(20px) saturate(160%);
    display: flex; align-items: flex-start; justify-content: center;
    padding: max(48px, 7vh) 16px 32px;
  }
  .editor-panel {
    width: 100%; max-width: 760px;
    max-height: calc(100dvh - max(48px, 7vh) - 32px);
    display: flex; flex-direction: column;
    background: var(--note-bg);
    border: 1px solid var(--note-border);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-lg);
    color: var(--text-1);
    overflow: hidden;
  }
  .editor-panel.narrow {
    max-width: none; max-height: none;
    position: fixed; inset: 0;
    border-radius: 0; border: none;
    padding-top: var(--safe-top);
  }
  .editor-top { display: flex; align-items: center; gap: 8px; padding: 22px 20px 4px 32px; }
  .narrow .editor-top { padding: 8px 8px 4px 4px; }
  .title-input {
    flex: 1; min-width: 0;
    background: none; border: none; outline: none;
    font-family: var(--font-note-title);
    font-weight: 500; font-size: 30px; line-height: 1.2; letter-spacing: -0.005em;
    color: var(--text-1);
  }
  .narrow .title-input { font-size: 26px; padding-left: 4px; }
  .title-input::placeholder { color: var(--text-3); }

  .editor-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 32px 20px; display: flex; flex-direction: column; gap: 16px; }
  .narrow .editor-scroll { padding: 8px 20px calc(88px + var(--safe-bottom) + var(--kb, 0px)); }

  .editor-chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip {
    height: 30px; display: inline-flex; align-items: center; gap: 6px; padding: 0 4px 0 11px;
    border-radius: var(--radius-full);
    background: color-mix(in srgb, var(--text-1) 7%, transparent);
    font-size: 13px; font-weight: 500; color: var(--text-2);
  }
  .chip-dot { width: 7px; height: 7px; border-radius: 50%; }
  .chip-share { padding: 0 12px 0 9px; cursor: pointer; }
  .chip-share:hover:not(:disabled) { background: color-mix(in srgb, var(--text-1) 11%, transparent); color: var(--text-1); }
  .chip-share:disabled { cursor: default; }
  .chip-share .material-symbols-rounded { font-size: 17px; }
  .chip-sub { color: var(--text-3); font-weight: 400; }
  .chip-x { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--text-2); }
  .chip-x:hover { background: color-mix(in srgb, var(--text-1) 10%, transparent); color: var(--text-1); }
  .chip-x .material-symbols-rounded { font-size: 15px; }

  .editor-bar {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 16px 10px 22px;
    border-top: 1px solid var(--note-border);
  }
  .narrow .editor-bar {
    position: fixed; left: 0; right: 0; bottom: 0;
    bottom: var(--kb, 0px);
    padding: 6px 8px calc(6px + var(--safe-bottom));
    background: var(--glass-surface);
    border-top-color: color-mix(in srgb, var(--note-glow, var(--accent)) 25%, var(--note-border));
    box-shadow: 0 -8px 24px -16px rgba(0, 0, 0, 0.6);
    z-index: 5;
    backdrop-filter: blur(24px) saturate(180%);
    -webkit-backdrop-filter: blur(24px) saturate(180%);
  }
  .bar-actions { display: flex; flex-wrap: nowrap; gap: 2px; min-width: 0; }
  .spacer { flex: 1; }
  .edited { font-size: 12px; color: var(--text-3); white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .compact-bar .edited { display: none; }
  .kb-open .editor-bar { padding-bottom: 6px; }
  .phone-bar { display: flex; align-items: center; gap: 2px; width: 100%; min-width: 0; }
  .compact-bar .phone-edited { display: block; overflow: hidden; text-overflow: ellipsis; min-width: 0; padding: 0 4px; font-size: 11px; }
  .fmt-row .fmt-scroll { display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none; flex: 1; min-width: 0; }
  .fmt-row .fmt-scroll::-webkit-scrollbar { display: none; }
  .fmt-row > .icon-btn { border-right: 1px solid var(--note-border); border-radius: 12px 0 0 12px; margin-right: 4px; }
  .sheet-menu { display: flex; flex-direction: column; min-width: 220px; }
  .sheet-item {
    display: flex; align-items: center; gap: 14px; min-height: 50px; padding: 0 12px;
    border-radius: 12px; font-size: 15px; color: var(--text-1); text-align: left;
  }
  .sheet-item .material-symbols-rounded { color: var(--text-2); font-size: 22px; }
  .sheet-item:hover { background: color-mix(in srgb, var(--text-1) 7%, transparent); }
  .sheet-item.danger, .sheet-item.danger .material-symbols-rounded { color: var(--danger); }
  .sheet-item .sheet-check { margin-left: auto; color: var(--accent); }
  .done { height: 40px; }

  .icon-btn {
    width: 40px; height: 40px; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    border-radius: 12px;
    color: var(--text-2);
  }
  .narrow .icon-btn { width: 44px; height: 44px; }
  .icon-btn:hover { background: color-mix(in srgb, var(--text-1) 8%, transparent); color: var(--text-1); }
  .icon-btn.on { color: var(--accent); background: var(--accent-dim); }
  .fill { font-variation-settings: 'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24; }
</style>
