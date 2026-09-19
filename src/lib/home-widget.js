/**
 * home-widget.js: keeps the Android Notes widget in step with the notes.
 *
 * The widget can't read the notes database (it belongs to the WebView), so
 * the app sends it a small snapshot: pinned notes first, then the latest
 * edits, each with a title, a few lines of text, and its colour. With App
 * Lock on, the widget only gets `locked`, so nothing shows on the home screen.
 */
import { get } from 'svelte/store';
import { _ } from 'svelte-i18n';
import { registerPlugin } from '@capacitor/core';
import { isNative } from './platform.js';
import { NoteApi } from './api.js';
import { widgetSnapshot } from './widget-snapshot.js';

const DEBOUNCE_MS = 1200;

// Created up front: a plugin proxy handed through a promise gets asked for .then() and throws.
const NoteWidget = isNative ? registerPlugin('NoteWidget') : null;
let _timer = null;

/** Send the widget the latest notes, a moment after the last change. */
export function refreshHomeWidget({ locked = false, now = false } = {}) {
  if (!isNative) return;
  clearTimeout(_timer);
  _timer = setTimeout(() => _send(locked), now ? 0 : DEBOUNCE_MS);
}

async function _send(locked) {
  if (!NoteWidget) return;
  try {
    const t = get(_);
    const notes = locked ? [] : await NoteApi.getNotes();
    await NoteWidget.update(widgetSnapshot(Array.isArray(notes) ? notes : [], { locked, t }));
  } catch { /* signed out or offline: keep what the widget has */ }
}

/** Signed out: the widget forgets the notes. */
export async function clearHomeWidget() {
  clearTimeout(_timer);
  try { await NoteWidget?.update({ locked: false, notes: [] }); } catch { /* ignore */ }
}
