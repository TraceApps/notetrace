package com.notetrace.app;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import java.util.HashSet;
import java.util.Set;

/**
 * NoteReminderReceiver: an alarm came due, or a notification button was
 * tapped.
 *
 *  - FIRE re-reads the reminder from the app's latest list, checks it
 *    still produces this occurrence (the note may have been edited,
 *    cleared, or trashed since the alarm was set) and that it wasn't shown
 *    already, shows the notification, and arms the next occurrence.
 *  - DONE on a one-off reminder drops it from the native list and queues
 *    the note id for the app, which clears the reminder through its normal
 *    data layer (and sync) the next time it runs. A repeating one keeps
 *    going. Nothing here opens the app's database; see NoteReminderStore.
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

    private void fire(Context ctx, long noteId, long occurrence, boolean snooze) {
        if (!NoteReminderScheduler.enabled(ctx)) return;
        NoteReminderStore.Reminder n = NoteReminderStore.find(ctx, noteId);
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

    private void show(Context ctx, long noteId, NoteReminderStore.Reminder n) {
        NoteReminderScheduler.ensureChannel(ctx);
        // The app works out the notification text when it writes the list.
        String body = n.body != null ? n.body : "";
        String title = n.title != null && !n.title.trim().isEmpty()
            ? n.title.trim() : NoteReminderScheduler.label(ctx, "reminder", "Reminder");

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
            // Icons matter on a watch, where a notification action without one
            // shows as an empty circle.
            .addAction(R.drawable.ic_action_done, NoteReminderScheduler.label(ctx, "done", "Done"), actionIntent(ctx, noteId, NoteReminderScheduler.ACTION_DONE))
            .addAction(R.drawable.ic_action_snooze, NoteReminderScheduler.label(ctx, "snooze", "Snooze 1 Hour"), actionIntent(ctx, noteId, NoteReminderScheduler.ACTION_SNOOZE));
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

    /** Done on a one-off reminder: stop it here, and queue it for the app to clear. */
    private void done(Context ctx, long noteId) {
        NoteReminderStore.Reminder n = NoteReminderStore.find(ctx, noteId);
        if (n == null || (n.rrule != null && ReminderMath.REPEATS.contains(n.rrule))) return;
        NoteReminderStore.remove(ctx, noteId);
        android.content.SharedPreferences p = NoteReminderScheduler.prefs(ctx);
        Set<String> pending = new HashSet<>(p.getStringSet("done_pending", new HashSet<>()));
        pending.add(String.valueOf(noteId));
        p.edit().putStringSet("done_pending", pending).apply();
    }
}
