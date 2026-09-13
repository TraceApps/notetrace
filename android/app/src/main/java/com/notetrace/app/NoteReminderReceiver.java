package com.notetrace.app;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import java.util.ArrayList;
import java.util.List;

/**
 * NoteReminderReceiver: an alarm came due, or a notification button was
 * tapped.
 *
 *  - FIRE re-reads the note, checks the reminder still produces this
 *    occurrence (it may have been edited, cleared, or trashed since the
 *    alarm was set) and that it wasn't shown already, shows the
 *    notification, and arms the next occurrence.
 *  - DONE clears a one-off reminder in the local database (marked pending,
 *    so sync sends the change to the server). A repeating one keeps going.
 *  - SNOOZE shows it again in an hour.
 *
 * Work runs off the main thread through goAsync().
 */
public class NoteReminderReceiver extends BroadcastReceiver {
    private static final String TAG = "NoteReminders";

    @Override
    public void onReceive(Context context, Intent intent) {
        final PendingResult result = goAsync();
        final Context ctx = context.getApplicationContext();
        new Thread(() -> {
            try {
                handle(ctx, intent);
            } catch (Exception e) {
                Log.w(TAG, "receiver failed: " + e.getMessage());
            } finally {
                result.finish();
            }
        }).start();
    }

    private void handle(Context ctx, Intent intent) {
        String action = intent.getAction();
        long noteId = intent.getLongExtra(NoteReminderScheduler.EXTRA_NOTE_ID, -1);
        if (noteId < 0 || action == null) return;
        switch (action) {
            case NoteReminderScheduler.ACTION_FIRE:
                fire(ctx, noteId, intent.getLongExtra(NoteReminderScheduler.EXTRA_OCCURRENCE, 0L),
                    intent.getBooleanExtra(NoteReminderScheduler.EXTRA_SNOOZE, false));
                NoteReminderScheduler.scheduleAll(ctx);
                break;
            case NoteReminderScheduler.ACTION_DONE:
                NotificationManagerCompat.from(ctx).cancel(notificationId(noteId));
                done(ctx, noteId);
                NoteReminderScheduler.scheduleAll(ctx);
                NoteRemindersPlugin.notifyChanged();
                break;
            case NoteReminderScheduler.ACTION_SNOOZE:
                NotificationManagerCompat.from(ctx).cancel(notificationId(noteId));
                NoteReminderScheduler.snooze(ctx, noteId);
                break;
            default:
                break;
        }
    }

    static int notificationId(long noteId) {
        return (int) (NoteReminderScheduler.NOTIFICATION_BASE + noteId);
    }

    private static final class NoteRow {
        String title, body, kind, at, rrule, tz;
        final List<String> openItems = new ArrayList<>();
    }

    private static NoteRow readNote(Context ctx, long noteId) {
        SQLiteDatabase db = null;
        Cursor c = null;
        try {
            db = NoteReminderScheduler.openDb(ctx, false);
            if (db == null) return null;
            c = db.rawQuery("SELECT title, body_md, kind, reminder_at, reminder_rrule, reminder_tz FROM notes " +
                "WHERE id = ? AND deleted_at IS NULL AND trashed_at IS NULL", new String[]{ String.valueOf(noteId) });
            if (!c.moveToFirst()) return null;
            NoteRow n = new NoteRow();
            n.title = c.getString(0); n.body = c.getString(1); n.kind = c.getString(2);
            n.at = c.getString(3); n.rrule = c.getString(4); n.tz = c.getString(5);
            c.close();
            if ("checklist".equals(n.kind)) {
                c = db.rawQuery("SELECT text FROM checklist_items WHERE note_id = ? AND deleted_at IS NULL AND checked = 0 " +
                    "ORDER BY position, id LIMIT 6", new String[]{ String.valueOf(noteId) });
                while (c.moveToNext()) n.openItems.add(c.getString(0));
            }
            return n;
        } catch (Exception e) {
            Log.w(TAG, "read note failed: " + e.getMessage());
            return null;
        } finally {
            if (c != null && !c.isClosed()) c.close();
            if (db != null) db.close();
        }
    }

    private void fire(Context ctx, long noteId, long occurrence, boolean snooze) {
        if (!NoteReminderScheduler.enabled(ctx)) return;
        NoteRow n = readNote(ctx, noteId);
        if (n == null || n.at == null) return;
        if (!snooze) {
            // The reminder must still land on this occurrence, and only show once.
            Long expected = ReminderMath.nextOccurrence(n.at, n.rrule, n.tz, occurrence - 1);
            if (expected == null || expected != occurrence) return;
            if (NoteReminderScheduler.lastFired(ctx, noteId) == occurrence) return;
            if (System.currentTimeMillis() - occurrence > NoteReminderScheduler.LATE_WINDOW_MS) return;
            NoteReminderScheduler.markFired(ctx, noteId, occurrence);
        }
        show(ctx, noteId, n);
    }

    private static String plainText(String md) {
        if (md == null) return "";
        return md.replaceAll("(?s)```.*?```", " ")
            .replaceAll("!\\[[^\\]]*\\]\\([^)]*\\)", "")
            .replaceAll("\\[([^\\]]*)\\]\\([^)]*\\)", "$1")
            .replaceAll("(?m)^\\s{0,3}(#{1,6}|>|[-*+]\\s+\\[[ xX]\\]|[-*+]|\\d+[.)])\\s+", "")
            .replaceAll("(\\*\\*|__|~~|`|\\*|_)", "")
            .replaceAll(" {2,}\\n", "\n")
            .replaceAll("\\n{2,}", "\n")
            .trim();
    }

    private void show(Context ctx, long noteId, NoteRow n) {
        NoteReminderScheduler.ensureChannel(ctx);
        String body;
        if ("checklist".equals(n.kind)) {
            StringBuilder sb = new StringBuilder();
            for (String item : n.openItems) { if (sb.length() > 0) sb.append('\n'); sb.append("• ").append(item); }
            body = sb.toString();
        } else {
            body = plainText(n.body);
            if (body.length() > 300) body = body.substring(0, 300);
        }
        String title = n.title != null && !n.title.trim().isEmpty() ? n.title.trim() : null;
        if (title == null) {
            int nl = body.indexOf('\n');
            if (body.isEmpty()) title = NoteReminderScheduler.label(ctx, "reminder", "Reminder");
            else if (nl < 0) { title = body; body = ""; }
            else { title = body.substring(0, nl); body = body.substring(nl + 1); }
            if (title.length() > 80) title = title.substring(0, 80);
        }

        int nid = notificationId(noteId);
        Intent open = new Intent(ctx, MainActivity.class);
        open.setAction(NoteRemindersPlugin.ACTION_OPEN_NOTE);
        open.putExtra(NoteReminderScheduler.EXTRA_NOTE_ID, noteId);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPi = PendingIntent.getActivity(ctx, nid, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, NoteReminderScheduler.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_notetrace)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(openPi)
            .addAction(0, NoteReminderScheduler.label(ctx, "done", "Done"), actionIntent(ctx, noteId, NoteReminderScheduler.ACTION_DONE))
            .addAction(0, NoteReminderScheduler.label(ctx, "snooze", "Snooze 1 Hour"), actionIntent(ctx, noteId, NoteReminderScheduler.ACTION_SNOOZE));
        try {
            NotificationManagerCompat.from(ctx).notify(nid, b.build());
        } catch (SecurityException e) {
            Log.w(TAG, "notification permission missing");
        }
    }

    private static PendingIntent actionIntent(Context ctx, long noteId, String action) {
        Intent i = new Intent(ctx, NoteReminderReceiver.class);
        i.setAction(action);
        i.setData(android.net.Uri.parse("notetrace-reminder://" + action.substring(action.lastIndexOf('_') + 1).toLowerCase() + "/" + noteId));
        i.putExtra(NoteReminderScheduler.EXTRA_NOTE_ID, noteId);
        return PendingIntent.getBroadcast(ctx, notificationId(noteId), i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** Done on a one-off reminder clears it, as a pending local change for sync. */
    private void done(Context ctx, long noteId) {
        NoteRow n = readNote(ctx, noteId);
        if (n == null || (n.rrule != null && ReminderMath.REPEATS.contains(n.rrule))) return;
        for (int attempt = 0; attempt < 5; attempt++) {
            SQLiteDatabase db = null;
            try {
                db = NoteReminderScheduler.openDb(ctx, true);
                if (db == null) return;
                ContentValues v = new ContentValues();
                v.putNull("reminder_at");
                v.putNull("reminder_rrule");
                v.putNull("reminder_tz");
                v.put("updated_at", ReminderMath.toUtcString(System.currentTimeMillis()));
                v.put("sync_status", "pending");
                db.update("notes", v, "id = ?", new String[]{ String.valueOf(noteId) });
                return;
            } catch (Exception e) {
                // The app may be mid-write on the same file; try again shortly.
                Log.w(TAG, "done write retry " + attempt + ": " + e.getMessage());
                try { Thread.sleep(250); } catch (InterruptedException ignored) { return; }
            } finally {
                if (db != null) db.close();
            }
        }
    }
}
