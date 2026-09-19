package com.notetrace.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;

/** Quick Note widget: a Take a note bar, with list, voice note, and drawing buttons. */
public class QuickNoteWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_quick);
        views.setOnClickPendingIntent(R.id.quick_note, open(context, "text", 11));
        views.setOnClickPendingIntent(R.id.quick_list, open(context, "checklist", 12));
        views.setOnClickPendingIntent(R.id.quick_voice, open(context, "voice", 13));
        views.setOnClickPendingIntent(R.id.quick_draw, open(context, "drawing", 14));
        manager.updateAppWidget(ids, views);
    }

    static PendingIntent open(Context context, String kind, int requestCode) {
        return PendingIntent.getActivity(context, requestCode, NoteWidgetStore.newNoteIntent(context, kind),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
