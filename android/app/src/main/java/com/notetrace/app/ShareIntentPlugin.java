package com.notetrace.app;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.MimeTypeMap;

import androidx.core.content.IntentCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Receives text, links, and images shared to NoteTrace from other apps (the
 * Android share sheet) and hands them to the web layer, which opens a new
 * note pre-filled with the shared content.
 *
 * handleIntent only records what was shared. getPending() copies shared
 * images into the app's cache (plugin calls run off the main thread) and
 * returns their file paths for the WebView to read and upload. A share that
 * cold-starts the app waits for getPending(); a share while the app runs
 * also emits "shareReceived" so the app asks for it right away.
 */
@CapacitorPlugin(name = "ShareIntent")
public class ShareIntentPlugin extends Plugin {
    private static final String TAG = "ShareIntent";
    private static final int MAX_IMAGES = 20;
    private static final long MAX_IMAGE_BYTES = 50L * 1024 * 1024;

    private static String pendingTitle = null;
    private static String pendingText = null;
    private static final List<Uri> pendingImages = new ArrayList<>();
    private static ShareIntentPlugin instance = null;

    @Override
    public void load() {
        instance = this;
    }

    static synchronized void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        String type = intent.getType();
        if (type == null || (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action))) return;

        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        List<Uri> images = new ArrayList<>();
        if (type.startsWith("image/")) {
            if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
                ArrayList<Uri> list = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri.class);
                if (list != null) images.addAll(list);
            } else {
                Uri uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
                if (uri != null) images.add(uri);
            }
        } else if (!type.startsWith("text/")) {
            return;
        }
        boolean hasText = (text != null && !text.isEmpty()) || (subject != null && !subject.isEmpty());
        if (!hasText && images.isEmpty()) return;

        pendingTitle = subject != null ? subject : "";
        pendingText = text != null ? text : "";
        pendingImages.clear();
        pendingImages.addAll(images.subList(0, Math.min(images.size(), MAX_IMAGES)));
        // Consume the intent so a later configuration change doesn't replay it.
        intent.setAction(Intent.ACTION_MAIN);

        if (instance != null && instance.hasListeners("shareReceived")) {
            instance.notifyListeners("shareReceived", new JSObject(), true);
        }
    }

    @PluginMethod
    public void getPending(PluginCall call) {
        String title, text;
        List<Uri> images;
        synchronized (ShareIntentPlugin.class) {
            if (pendingTitle == null) { call.resolve(new JSObject()); return; }
            title = pendingTitle;
            text = pendingText;
            images = new ArrayList<>(pendingImages);
            pendingTitle = null;
            pendingText = null;
            pendingImages.clear();
        }
        JSObject share = new JSObject();
        share.put("title", title);
        share.put("text", text);
        share.put("images", copyImages(getContext(), images));
        JSObject result = new JSObject();
        result.put("share", share);
        call.resolve(result);
    }

    private static JSArray copyImages(Context ctx, List<Uri> uris) {
        JSArray out = new JSArray();
        File dir = new File(ctx.getCacheDir(), "shared");
        // Earlier shares are uploaded by now; clear them before copying new ones.
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) f.delete();
        if (!dir.exists() && !dir.mkdirs()) return out;
        ContentResolver cr = ctx.getContentResolver();
        for (Uri uri : uris) {
            String mime = cr.getType(uri);
            if (mime == null || !mime.startsWith("image/")) continue;
            String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
            String name = displayName(cr, uri);
            File target = new File(dir, UUID.randomUUID() + "." + (ext != null ? ext : "img"));
            long copied = 0;
            try (InputStream in = cr.openInputStream(uri); OutputStream os = new FileOutputStream(target)) {
                if (in == null) continue;
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    copied += n;
                    if (copied > MAX_IMAGE_BYTES) throw new IllegalStateException("image too large");
                    os.write(buf, 0, n);
                }
            } catch (Exception e) {
                Log.w(TAG, "couldn't copy shared image: " + e.getMessage());
                target.delete();
                continue;
            }
            JSObject img = new JSObject();
            img.put("path", target.getAbsolutePath());
            img.put("mime", mime);
            img.put("name", name != null ? name : target.getName());
            out.put(img);
        }
        return out;
    }

    private static String displayName(ContentResolver cr, Uri uri) {
        try (Cursor c = cr.query(uri, new String[]{ OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) { }
        return null;
    }
}
