package com.notetrace.app;

import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Receives text and links shared to NoteTrace from other apps (the Android
 * share sheet) and hands them to the web layer, which opens a new note
 * pre-filled with the shared content.
 *
 * A share that cold-starts the app is held until JS asks for it with
 * getPending(); a share while the app is running is also emitted as a
 * "shareReceived" event.
 */
@CapacitorPlugin(name = "ShareIntent")
public class ShareIntentPlugin extends Plugin {
    private static JSObject pending = null;
    private static ShareIntentPlugin instance = null;

    @Override
    public void load() {
        instance = this;
    }

    static void handleIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String type = intent.getType();
        if (type == null || !type.startsWith("text/")) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if ((text == null || text.isEmpty()) && (subject == null || subject.isEmpty())) return;

        JSObject share = new JSObject();
        share.put("title", subject != null ? subject : "");
        share.put("text", text != null ? text : "");
        pending = share;
        // Consume the intent so a later configuration change doesn't replay it.
        intent.setAction(Intent.ACTION_MAIN);

        if (instance != null && instance.hasListeners("shareReceived")) {
            instance.notifyListeners("shareReceived", share, true);
            pending = null;
        }
    }

    @PluginMethod
    public void getPending(PluginCall call) {
        JSObject result = new JSObject();
        if (pending != null) {
            result.put("share", pending);
            pending = null;
        }
        call.resolve(result);
    }
}
