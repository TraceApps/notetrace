package com.notetrace.app;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * NoteReminderStore: the reminder list the native side works from.
 *
 * The app writes it (NoteRemindersPlugin.reschedule) after every note change
 * or sync: one entry per note with a reminder, with the notification text
 * already worked out. The native code never opens the app's SQLite database:
 * that file is held open by the Capacitor SQLite plugin's own SQLite build,
 * and a second SQLite library in the same process can release the plugin's
 * file locks and corrupt the database. This file survives reboots, so
 * BootReceiver can re-arm alarms without starting the app.
 */
final class NoteReminderStore {
    private static final String TAG = "NoteReminders";
    private static final String FILE = "note-reminders.json";

    static final class Reminder {
        long id;
        String title, body, at, rrule, tz;
    }

    private NoteReminderStore() {}

    private static File file(Context ctx) {
        return new File(ctx.getFilesDir(), FILE);
    }

    static synchronized List<Reminder> read(Context ctx) {
        List<Reminder> out = new ArrayList<>();
        File f = file(ctx);
        if (!f.exists()) return out;
        try (InputStream in = new FileInputStream(f)) {
            byte[] bytes = new byte[(int) f.length()];
            int off = 0;
            while (off < bytes.length) {
                int n = in.read(bytes, off, bytes.length - off);
                if (n < 0) break;
                off += n;
            }
            JSONArray arr = new JSONArray(new String(bytes, 0, off, StandardCharsets.UTF_8));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null || !o.has("id") || o.optString("at", "").isEmpty()) continue;
                Reminder r = new Reminder();
                r.id = o.optLong("id");
                r.title = o.optString("title", "");
                r.body = o.optString("body", "");
                r.at = o.optString("at");
                r.rrule = o.isNull("rrule") ? null : o.optString("rrule", null);
                r.tz = o.isNull("tz") ? null : o.optString("tz", null);
                out.add(r);
            }
        } catch (Exception e) {
            Log.w(TAG, "reminder list unreadable: " + e.getMessage());
        }
        return out;
    }

    static synchronized Reminder find(Context ctx, long id) {
        for (Reminder r : read(ctx)) if (r.id == id) return r;
        return null;
    }

    /** Replace the list. Written to a temp file and renamed, so a crash never leaves half a file. */
    static synchronized void write(Context ctx, JSONArray reminders) {
        File target = file(ctx);
        File tmp = new File(ctx.getFilesDir(), FILE + ".tmp");
        try (OutputStream os = new FileOutputStream(tmp)) {
            os.write(reminders.toString().getBytes(StandardCharsets.UTF_8));
            os.flush();
        } catch (Exception e) {
            Log.w(TAG, "reminder list write failed: " + e.getMessage());
            return;
        }
        if (!tmp.renameTo(target)) Log.w(TAG, "reminder list rename failed");
    }

    /** Drop one note's reminder (Done on a one-off) until the app writes the list again. */
    static synchronized void remove(Context ctx, long id) {
        JSONArray kept = new JSONArray();
        for (Reminder r : read(ctx)) {
            if (r.id == id) continue;
            try {
                JSONObject o = new JSONObject();
                o.put("id", r.id); o.put("title", r.title); o.put("body", r.body);
                o.put("at", r.at); o.put("rrule", r.rrule == null ? JSONObject.NULL : r.rrule);
                o.put("tz", r.tz == null ? JSONObject.NULL : r.tz);
                kept.put(o);
            } catch (Exception ignored) { }
        }
        write(ctx, kept);
    }
}
