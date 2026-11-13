package com.notetrace.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.util.Log;

import android.os.Handler;
import android.os.Looper;

import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.TaskCompletionSource;
import com.google.android.gms.tasks.Tasks;
import com.google.android.gms.wearable.DataClient;
import com.google.android.gms.wearable.MessageClient;
import com.google.android.gms.wearable.PutDataMapRequest;
import com.google.android.gms.wearable.PutDataRequest;
import com.google.android.gms.wearable.Wearable;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Hands the watch what it needs to reach the server: the address and the
 * signed-in account's token, written once into the Wearable Data Layer. The
 * watch app (android/wear) picks it up and talks to the server itself, so it
 * keeps working with the phone out of range.
 *
 * Nothing is typed on the watch, and signing out on the phone takes the
 * credentials away again.
 */
@CapacitorPlugin(name = "WearPairing")
public class WearPairingPlugin extends Plugin {

    private static final String PATH = "/notetrace/pairing";
    private static final String TAG = "WearPairing";
    /**
     * Local mode: the watch asks this phone what it would ask a server, and
     * the app's own local handlers answer (watch-relay.js). Registered only
     * while the app runs, so with the app closed the watch keeps what it
     * changed and says to open NoteTrace on the phone.
     */
    private static final String API_PATH = "/notetrace/api";
    private static final long ANSWER_WITHIN_MS = 20000L;
    private final Map<String, TaskCompletionSource<byte[]>> waiting = new ConcurrentHashMap<>();
    private final Handler timeouts = new Handler(Looper.getMainLooper());

    private static byte[] reply(int status, String body) {
        try {
            return new JSONObject().put("status", status).put("body", body == null ? "" : body)
                .toString().getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) {
            return ("{\"status\":" + status + "}").getBytes(StandardCharsets.UTF_8);
        }
    }

    private final MessageClient.RpcService apiService = (nodeId, path, data) -> {
        // The watch is in use: the app stays awake for it when it leaves the screen.
        WatchAwakeService.lastWatchRequestAt = System.currentTimeMillis();
        if (!hasListeners("watchRequest")) {
            return Tasks.forResult(reply(503, "{\"error\":\"NoteTrace isn't ready on the phone\"}"));
        }
        JSObject req = new JSObject();
        try {
            JSONObject in = new JSONObject(new String(data == null ? new byte[0] : data, StandardCharsets.UTF_8));
            req.put("method", in.optString("method", "GET"));
            req.put("path", in.optString("path", ""));
            req.put("body", in.isNull("body") ? null : in.optString("body", null));
        } catch (Exception e) {
            return Tasks.forResult(reply(400, "{\"error\":\"Bad request\"}"));
        }
        String id = UUID.randomUUID().toString();
        req.put("id", id);
        TaskCompletionSource<byte[]> answer = new TaskCompletionSource<>();
        waiting.put(id, answer);
        // An app that never answers (busy, or going away) still lets the watch
        // move on: it keeps what it changed and tries again.
        timeouts.postDelayed(() -> {
            TaskCompletionSource<byte[]> late = waiting.remove(id);
            if (late != null) late.trySetResult(reply(504, "{\"error\":\"The phone took too long\"}"));
        }, ANSWER_WITHIN_MS);
        notifyListeners("watchRequest", req);
        return answer.getTask();
    };

    /** The running plugin, for the debug build's stand-in watch (src/debug WatchRequestProbe). */
    static volatile WearPairingPlugin current;

    /** Ask the way the watch does; only the debug build calls this. */
    Task<byte[]> askLikeTheWatch(byte[] data) {
        return apiService.onRequest("debug", API_PATH, data);
    }

    @Override
    public void load() {
        try {
            Wearable.getMessageClient(getContext()).addRpcService(apiService, API_PATH);
            current = this;
        } catch (Exception e) {
            Log.w(TAG, "no watch messages here: " + e.getMessage());
        }
    }

    @Override
    protected void handleOnDestroy() {
        try {
            Wearable.getMessageClient(getContext()).removeRpcService(apiService);
            if (current == this) current = null;
        } catch (Exception e) {
            Log.w(TAG, "couldn't stop listening: " + e.getMessage());
        }
    }

    /**
     * Keep the app awake for the watch while it's off screen (on), or not
     * (off). On only takes effect with a watch connected or used in the last
     * 30 minutes, so a phone with no watch around shows nothing.
     */
    @PluginMethod
    public void keepAwake(PluginCall call) {
        if (!Boolean.TRUE.equals(call.getBoolean("on", false))) {
            WatchAwakeService.stop(getContext());
            call.resolve();
            return;
        }
        String title = call.getString("title", "NoteTrace");
        String text = call.getString("text", "");
        // Used lately, or connected now: you may start on the watch after
        // putting the phone away, and by then a frozen app couldn't answer.
        if (WatchAwakeService.watchInUse()) {
            WatchAwakeService.start(getContext(), title, text);
            call.resolve();
            return;
        }
        Wearable.getNodeClient(getContext()).getConnectedNodes()
            .addOnSuccessListener(nodes -> {
                if (nodes != null && !nodes.isEmpty()) WatchAwakeService.start(getContext(), title, text);
                call.resolve();
            })
            .addOnFailureListener(e -> call.resolve());
    }

    /** The app's answer to one of the watch's requests. */
    @PluginMethod
    public void answer(PluginCall call) {
        TaskCompletionSource<byte[]> answer = waiting.remove(call.getString("id", ""));
        if (answer != null) {
            Integer status = call.getInt("status", 500);
            answer.trySetResult(reply(status == null ? 500 : status, call.getString("body", "")));
        }
        call.resolve();
    }


    /** True when a watch is paired with this phone, so the UI can say so. */
    @PluginMethod
    public void hasWatch(PluginCall call) {
        Wearable.getNodeClient(getContext()).getConnectedNodes()
            .addOnSuccessListener(nodes -> {
                Log.i(TAG, "connected nodes: " + (nodes == null ? 0 : nodes.size()));
                JSObject ret = new JSObject();
                ret.put("paired", nodes != null && !nodes.isEmpty());
                ret.put("count", nodes == null ? 0 : nodes.size());
                call.resolve(ret);
            })
            .addOnFailureListener(e -> {
                Log.w(TAG, "couldn't list nodes: " + e.getMessage());
                JSObject ret = new JSObject();
                ret.put("paired", false);
                ret.put("count", 0);
                call.resolve(ret);
            });
    }

    /** Send the server address and token to the watch. */
    @PluginMethod
    public void pair(PluginCall call) {
        String serverUrl = call.getString("serverUrl", "");
        String token = call.getString("token", "");
        if (serverUrl == null || serverUrl.isEmpty() || token == null || token.isEmpty()) {
            call.reject("serverUrl and token are required");
            return;
        }
        PutDataMapRequest req = PutDataMapRequest.create(PATH);
        req.getDataMap().putString("serverUrl", serverUrl);
        // The server again when the app confirmed plain HTTP to it (a server on
        // your own network, TraceApps/nutritrace#194), otherwise empty: the
        // watch sends over plain HTTP only when they match.
        req.getDataMap().putString("httpOk", call.getString("httpOk", ""));
        req.getDataMap().putString("token", token);
        // The release this phone runs: a watch on an older one updates itself
        // to it (installed from GitHub; the Play Store keeps its own current).
        req.getDataMap().putString("appVersion", call.getString("appVersion", ""));
        // The timestamp makes every write distinct, so re-pairing after a token
        // refresh still reaches the watch instead of being seen as unchanged.
        req.getDataMap().putLong("at", System.currentTimeMillis());
        PutDataRequest put = req.asPutDataRequest().setUrgent();

        DataClient client = Wearable.getDataClient(getContext());
        client.putDataItem(put)
            .addOnSuccessListener(item -> {
                Log.i(TAG, "sent the link to the watch");
                JSObject ret = new JSObject();
                ret.put("sent", true);
                call.resolve(ret);
            })
            .addOnFailureListener(e -> call.reject(e.getMessage() == null ? "Couldn't reach the watch" : e.getMessage()));
    }

    /** Signed out on the phone: take the credentials off the watch. */
    @PluginMethod
    public void unpair(PluginCall call) {
        Wearable.getDataClient(getContext())
            .deleteDataItems(new android.net.Uri.Builder().scheme("wear").path(PATH).build())
            .addOnSuccessListener(count -> {
                JSObject ret = new JSObject();
                ret.put("cleared", true);
                call.resolve(ret);
            })
            .addOnFailureListener(e -> call.reject(e.getMessage() == null ? "Couldn't reach the watch" : e.getMessage()));
    }
}
