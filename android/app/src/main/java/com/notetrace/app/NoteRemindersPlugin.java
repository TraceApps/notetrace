package com.notetrace.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * NoteReminders: the WebView's bridge to the native reminder engine.
 *
 *   configure({ enabled, labels })  device setting + notification strings
 *   reschedule({ reminders })       replace the reminder list, re-arm alarms
 *   takeDone()                      note ids whose one-off reminder got Done
 *   getPendingOpen()                note id from a notification tap at cold start
 *   exactAlarmStatus() / openExactAlarmSettings()
 *
 * Events: "reminderOpen" { noteId } when a notification is tapped while the
 * app runs, "remindersChanged" after Done, so the app can take the ids.
 */
@CapacitorPlugin(name = "NoteReminders")
public class NoteRemindersPlugin extends Plugin {
    static final String ACTION_OPEN_NOTE = "com.notetrace.app.OPEN_NOTE";
    private static NoteRemindersPlugin instance;
    private static Long pendingOpen = null;

    @Override
    public void load() {
        instance = this;
    }

    /** From MainActivity: a reminder notification opened the app. */
    public static void handleIntent(Intent intent) {
        if (intent == null || !ACTION_OPEN_NOTE.equals(intent.getAction())) return;
        long id = intent.getLongExtra(NoteReminderScheduler.EXTRA_NOTE_ID, -1);
        if (id < 0) return;
        intent.setAction(null); // don't reopen it on a configuration change
        if (instance != null && instance.hasListeners("reminderOpen")) {
            JSObject data = new JSObject();
            data.put("noteId", id);
            instance.notifyListeners("reminderOpen", data, true);
        } else {
            pendingOpen = id;
        }
    }

    static void notifyChanged() {
        if (instance != null) instance.notifyListeners("remindersChanged", new JSObject(), true);
    }

    @PluginMethod
    public void configure(PluginCall call) {
        android.content.SharedPreferences.Editor e = NoteReminderScheduler.prefs(getContext()).edit();
        if (call.hasOption("enabled")) e.putBoolean("enabled", Boolean.TRUE.equals(call.getBoolean("enabled", true)));
        JSObject labels = call.getObject("labels");
        if (labels != null) {
            for (String key : new String[]{ "done", "snooze", "reminder", "channel" }) {
                String v = labels.getString(key);
                if (v != null && !v.isEmpty()) e.putString("label_" + key, v);
            }
        }
        e.apply();
        call.resolve();
    }

    @PluginMethod
    public void reschedule(PluginCall call) {
        JSArray reminders = call.getArray("reminders");
        getBridge().execute(() -> {
            if (reminders != null) NoteReminderStore.write(getContext(), reminders);
            int armed = NoteReminderScheduler.scheduleAll(getContext());
            JSObject r = new JSObject();
            r.put("armed", armed);
            r.put("exact", NoteReminderScheduler.canScheduleExact(getContext()));
            call.resolve(r);
        });
    }

    @PluginMethod
    public void takeDone(PluginCall call) {
        android.content.SharedPreferences p = NoteReminderScheduler.prefs(getContext());
        java.util.Set<String> ids = p.getStringSet("done_pending", new java.util.HashSet<>());
        JSArray out = new JSArray();
        for (String id : ids) {
            try { out.put(Long.parseLong(id)); } catch (NumberFormatException ignored) { }
        }
        p.edit().remove("done_pending").apply();
        JSObject r = new JSObject();
        r.put("noteIds", out);
        call.resolve(r);
    }

    @PluginMethod
    public void getPendingOpen(PluginCall call) {
        JSObject r = new JSObject();
        if (pendingOpen != null) r.put("noteId", pendingOpen);
        pendingOpen = null;
        call.resolve(r);
    }

    @PluginMethod
    public void exactAlarmStatus(PluginCall call) {
        JSObject r = new JSObject();
        r.put("exact", NoteReminderScheduler.canScheduleExact(getContext()));
        call.resolve(r);
    }

    @PluginMethod
    public void openExactAlarmSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Intent i = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
        call.resolve();
    }
}
