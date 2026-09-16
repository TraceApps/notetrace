package com.notetrace.app;

import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONArray;
import org.json.JSONObject;

/** The rows of the Notes widget, from the app's last snapshot. */
public class NotesWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Rows(getApplicationContext());
    }

    static class Rows implements RemoteViewsFactory {
        private final Context context;
        private JSONArray notes = new JSONArray();

        Rows(Context context) { this.context = context; }

        @Override public void onCreate() {}
        @Override public void onDestroy() {}

        @Override
        public void onDataSetChanged() {
            JSONObject snapshot = NoteWidgetStore.load(context);
            notes = snapshot != null && snapshot.optBoolean("locked") ? new JSONArray() : NoteWidgetStore.notes(snapshot);
        }

        @Override public int getCount() { return notes.length(); }

        @Override
        public RemoteViews getViewAt(int position) {
            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_note_row);
            JSONObject note = notes.optJSONObject(position);
            if (note == null) return row;
            String title = note.optString("title", "").trim();
            String text = note.optString("text", "").trim();
            if (title.isEmpty() && text.isEmpty()) title = context.getString(R.string.widget_untitled);
            row.setTextViewText(R.id.row_title, title.isEmpty() ? text : title);
            row.setViewVisibility(R.id.row_title, View.VISIBLE);
            row.setTextViewText(R.id.row_text, title.isEmpty() ? "" : text);
            row.setViewVisibility(R.id.row_text, title.isEmpty() || text.isEmpty() ? View.GONE : View.VISIBLE);
            row.setInt(R.id.row_title, "setMaxLines", title.isEmpty() ? 3 : 1);

            String color = note.optString("color", "");
            int dot = parse(color);
            if (dot != 0) {
                row.setInt(R.id.row_dot, "setColorFilter", dot);
                row.setViewVisibility(R.id.row_dot, View.VISIBLE);
            } else {
                row.setViewVisibility(R.id.row_dot, View.GONE);
            }
            row.setViewVisibility(R.id.row_pin, note.optBoolean("pinned") ? View.VISIBLE : View.GONE);

            Intent fill = new Intent();
            fill.putExtra(NoteReminderScheduler.EXTRA_NOTE_ID, note.optLong("id", -1));
            row.setOnClickFillInIntent(R.id.row, fill);
            return row;
        }

        private static int parse(String color) {
            if (color == null || !color.matches("#[0-9a-fA-F]{6}")) return 0;
            try { return Color.parseColor(color); } catch (Exception e) { return 0; }
        }

        @Override public RemoteViews getLoadingView() { return null; }
        @Override public int getViewTypeCount() { return 1; }
        @Override public long getItemId(int position) {
            JSONObject note = notes.optJSONObject(position);
            return note == null ? position : note.optLong("id", position);
        }
        @Override public boolean hasStableIds() { return true; }
    }
}
