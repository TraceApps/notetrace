package com.notetrace.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.widget.RemoteViews;

import org.json.JSONObject;

/** Notes widget: pinned notes, then the latest edits. Tap one to open it. */
public class NotesWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        render(context, manager, ids);
        manager.notifyAppWidgetViewDataChanged(ids, R.id.notes_list);
    }

    static void render(Context context, AppWidgetManager manager, int[] ids) {
        JSONObject snapshot = NoteWidgetStore.load(context);
        int empty = snapshot == null ? R.string.widget_waiting
            : snapshot.optBoolean("locked") ? R.string.widget_locked
            : R.string.widget_empty;
        for (int id : ids) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_notes);

            Intent service = new Intent(context, NotesWidgetService.class);
            service.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
            // Each widget needs its own adapter intent, or they all share one list.
            service.setData(Uri.parse(service.toUri(Intent.URI_INTENT_SCHEME)));
            views.setRemoteAdapter(R.id.notes_list, service);
            views.setEmptyView(R.id.notes_list, R.id.notes_empty);
            views.setTextViewText(R.id.notes_empty, context.getString(empty));

            // A row fills in its note id; the app opens it like a reminder tap.
            Intent openNote = new Intent(context, MainActivity.class);
            openNote.setAction(NoteRemindersPlugin.ACTION_OPEN_NOTE);
            openNote.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int mutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
            views.setPendingIntentTemplate(R.id.notes_list,
                PendingIntent.getActivity(context, 20, openNote, PendingIntent.FLAG_UPDATE_CURRENT | mutable));

            Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
            if (launch != null) {
                views.setOnClickPendingIntent(R.id.notes_header,
                    PendingIntent.getActivity(context, 21, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            }
            views.setOnClickPendingIntent(R.id.notes_add, QuickNoteWidgetProvider.open(context, "text", 22));
            views.setOnClickPendingIntent(R.id.notes_voice, QuickNoteWidgetProvider.open(context, "voice", 23));
            manager.updateAppWidget(id, views);
        }
    }
}
