package com.notetrace.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * BootReceiver: alarms don't survive a reboot or an app update, and they
 * fire at wall-clock times, so reboots, updates, and clock or time zone
 * changes all re-arm the note reminders.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        final PendingResult result = goAsync();
        final Context ctx = context.getApplicationContext();
        new Thread(() -> {
            try {
                NoteReminderScheduler.scheduleAll(ctx);
            } catch (Exception e) {
                Log.w("NoteReminders", "boot reschedule failed: " + e.getMessage());
            } finally {
                result.finish();
            }
        }).start();
    }
}
