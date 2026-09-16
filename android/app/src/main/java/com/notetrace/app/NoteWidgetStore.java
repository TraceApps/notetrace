package com.notetrace.app;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * What the Notes widget shows. The app hands over a small snapshot (titles,
 * a line or two of text, colours) whenever notes change; the widget never
 * reads the notes database itself, which belongs to the WebView's SQLite.
 */
final class NoteWidgetStore {
    private static final String PREFS = "note_widget";
    private static final String KEY = "snapshot";

    private NoteWidgetStore() {}

    static void save(Context context, String json) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, json).apply();
    }

    /** The saved snapshot, or null before the app has sent one. */
    static JSONObject load(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString(KEY, null);
        if (raw == null) return null;
        try { return new JSONObject(raw); } catch (Exception e) { return null; }
    }

    static JSONArray notes(JSONObject snapshot) {
        JSONArray a = snapshot == null ? null : snapshot.optJSONArray("notes");
        return a == null ? new JSONArray() : a;
    }

    /** A notetrace://new/<kind> link, the same one the app shortcuts use. */
    static Intent newNoteIntent(Context context, String kind) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("notetrace://new/" + kind));
        i.setClassName(context, MainActivity.class.getName());
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return i;
    }

    /** Redraw every widget after a new snapshot. */
    static void refreshAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, NotesWidgetProvider.class));
        if (ids.length == 0) return;
        NotesWidgetProvider.render(context, manager, ids);
        manager.notifyAppWidgetViewDataChanged(ids, R.id.notes_list);
    }
}
