package com.notetrace.app;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import java.util.HashSet;
import java.util.Set;

/**
 * NoteReminderScheduler: schedules note reminders as exact alarms.
 *
 * Works from NoteReminderStore, the reminder list the app keeps current, so
 * it runs after a reboot or with the app closed. One alarm per note, for its
 * next occurrence; when it fires, NoteReminderReceiver shows the
 * notification and calls scheduleAll again to arm the one after.
 *
 * Why AlarmManager: setExactAndAllowWhileIdle is the only way to fire at a
 * set time under Doze (NutriTrace moved to it for the same reason). Android's
 * own repeating alarms are inexact and repeat every 24 hours, which drifts an
 * hour across daylight saving; each occurrence is computed in the note's
 * time zone instead (ReminderMath).
 *
 * Called from the app (NoteRemindersPlugin.reschedule after any note change
 * or sync), after each alarm, and from BootReceiver.
 */
public final class NoteReminderScheduler {
    private static final String TAG = "NoteReminders";
    static final String PREFS = "notetrace_reminders";
    static final String CHANNEL_ID = "notetrace-reminders";

    static final String ACTION_FIRE = "com.notetrace.app.NOTE_REMINDER_FIRE";
    static final String ACTION_DONE = "com.notetrace.app.NOTE_REMINDER_DONE";
    static final String ACTION_SNOOZE = "com.notetrace.app.NOTE_REMINDER_SNOOZE";
    static final String EXTRA_NOTE_ID = "noteId";
    static final String EXTRA_OCCURRENCE = "occurrence";
    static final String EXTRA_SNOOZE = "snooze";

    /** An alarm that was delayed (Doze, reboot) still shows if it's this late at most. */
    static final long LATE_WINDOW_MS = 10 * 60 * 1000L;
    static final long SNOOZE_MS = 60 * 60 * 1000L;
    static final int NOTIFICATION_BASE = 1_000_000;
    private static final int SNOOZE_REQUEST_BASE = 2_000_000;

    private NoteReminderScheduler() {}

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean enabled(Context ctx) {
        return prefs(ctx).getBoolean("enabled", true);
    }

    static String label(Context ctx, String key, String fallback) {
        return prefs(ctx).getString("label_" + key, fallback);
    }

    static void ensureChannel(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID,
            label(ctx, "channel", "Note reminders"), NotificationManager.IMPORTANCE_HIGH);
        ch.setLockscreenVisibility(android.app.Notification.VISIBILITY_PRIVATE);
        nm.createNotificationChannel(ch);
    }

    static long lastFired(Context ctx, long noteId) {
        return prefs(ctx).getLong("fired_" + noteId, 0L);
    }

    static void markFired(Context ctx, long noteId, long occurrence) {
        prefs(ctx).edit().putLong("fired_" + noteId, occurrence).apply();
    }

    /** Arm one alarm per note with a reminder; cancel alarms for notes that no longer have one. */
    public static synchronized int scheduleAll(Context ctx) {
        SharedPreferences p = prefs(ctx);
        Set<String> previous = new HashSet<>(p.getStringSet("scheduled", new HashSet<>()));
        Set<String> now = new HashSet<>();
        long nowMs = System.currentTimeMillis();

        if (enabled(ctx)) {
            try {
                for (NoteReminderStore.Reminder r : NoteReminderStore.read(ctx)) {
                    Long occ = nextToArm(ctx, r.id, r.at, r.rrule, r.tz, nowMs);
                    if (occ == null) continue;
                    arm(ctx, r.id, Math.max(occ, nowMs + 1000L), occ, false);
                    now.add(String.valueOf(r.id));
                }
            } catch (Exception e) {
                Log.w(TAG, "scheduleAll failed: " + e.getMessage());
            }
        }

        for (String id : previous) {
            if (!now.contains(id)) cancel(ctx, Long.parseLong(id));
        }
        p.edit().putStringSet("scheduled", now).apply();
        Log.d(TAG, "armed " + now.size() + " reminder(s)");
        return now.size();
    }

    /**
     * The occurrence to arm: one that came due in the last LATE_WINDOW_MS and
     * hasn't been shown yet (a delayed alarm), otherwise the next upcoming one.
     * Null for a one-off reminder that's already over.
     */
    static Long nextToArm(Context ctx, long noteId, String at, String rrule, String tz, long nowMs) {
        Long due = ReminderMath.dueOccurrence(at, rrule, tz, nowMs, LATE_WINDOW_MS);
        if (due != null && lastFired(ctx, noteId) != due) return due;
        Long next = ReminderMath.nextOccurrence(at, rrule, tz, nowMs);
        if (next == null || next <= nowMs) return null;
        return next;
    }

    private static PendingIntent fireIntent(Context ctx, long noteId, long occurrence, boolean snooze, int flags) {
        Intent i = new Intent(ctx, NoteReminderReceiver.class);
        i.setAction(ACTION_FIRE);
        // A distinct data URI per note keeps each PendingIntent separate.
        i.setData(Uri.parse("notetrace-reminder://" + (snooze ? "snooze" : "note") + "/" + noteId));
        i.putExtra(EXTRA_NOTE_ID, noteId);
        i.putExtra(EXTRA_OCCURRENCE, occurrence);
        i.putExtra(EXTRA_SNOOZE, snooze);
        int code = (int) ((snooze ? SNOOZE_REQUEST_BASE : 0) + noteId);
        return PendingIntent.getBroadcast(ctx, code, i, flags | PendingIntent.FLAG_IMMUTABLE);
    }

    static void arm(Context ctx, long noteId, long triggerMs, long occurrence, boolean snooze) {
        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        if (am == null) return;
        PendingIntent pi = fireIntent(ctx, noteId, occurrence, snooze, PendingIntent.FLAG_UPDATE_CURRENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
            // Without the exact-alarm permission, fire as close as Doze allows.
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMs, pi);
        } else {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMs, pi);
        }
    }

    static void cancel(Context ctx, long noteId) {
        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        if (am == null) return;
        PendingIntent pi = fireIntent(ctx, noteId, 0L, false, PendingIntent.FLAG_NO_CREATE);
        if (pi != null) { am.cancel(pi); pi.cancel(); }
    }

    static void snooze(Context ctx, long noteId) {
        long at = System.currentTimeMillis() + SNOOZE_MS;
        arm(ctx, noteId, at, at, true);
    }

    static boolean canScheduleExact(Context ctx) {
        AlarmManager am = ctx.getSystemService(AlarmManager.class);
        return am != null && (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms());
    }
}
