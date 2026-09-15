package com.notetrace.app;

import android.Manifest;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.media.MediaMuxer;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * Voice notes recorded natively (VoiceRecorderService), so they keep going with
 * the screen off. The web layer (src/lib/voice-recorder.js) drives it:
 * start, pause, resume, getStatus while recording, then stop for the file.
 * splitFile cuts a long M4A into pieces without re-encoding, for transcribing
 * on a device with no server.
 */
@CapacitorPlugin(
    name = "VoiceRecorder",
    permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone") }
)
public class VoiceRecorderPlugin extends Plugin {
    private static final int WAVEFORM_BARS = 64;

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "micPermission");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void micPermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) begin(call);
        else call.reject("denied");
    }

    private void begin(PluginCall call) {
        if ("recording".equals(VoiceRecorderService.state) || "paused".equals(VoiceRecorderService.state)) {
            call.reject("busy");
            return;
        }
        VoiceRecorderService.state = "starting";
        VoiceRecorderService.send(getContext(), VoiceRecorderService.ACTION_START);
        JSObject out = new JSObject();
        out.put("limitMs", VoiceRecorderService.MAX_MS);
        call.resolve(out);
    }

    @PluginMethod
    public void pause(PluginCall call) {
        VoiceRecorderService.send(getContext(), VoiceRecorderService.ACTION_PAUSE);
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        VoiceRecorderService.send(getContext(), VoiceRecorderService.ACTION_RESUME);
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject out = new JSObject();
        out.put("state", VoiceRecorderService.state);
        out.put("elapsedMs", VoiceRecorderService.currentElapsedMs());
        out.put("level", VoiceRecorderService.takePeak());
        if (VoiceRecorderService.error != null) out.put("error", VoiceRecorderService.error);
        call.resolve(out);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (!"stopped".equals(VoiceRecorderService.state)) {
            VoiceRecorderService.send(getContext(), VoiceRecorderService.ACTION_STOP);
        }
        getBridge().execute(() -> {
            long until = System.currentTimeMillis() + 8000;
            while (System.currentTimeMillis() < until) {
                String s = VoiceRecorderService.state;
                if ("stopped".equals(s) || "error".equals(s) || "idle".equals(s)) break;
                try { Thread.sleep(50); } catch (InterruptedException e) { break; }
            }
            File f = VoiceRecorderService.resultFile;
            if (f == null || !f.exists()) {
                call.reject(VoiceRecorderService.error != null ? VoiceRecorderService.error : "Nothing was recorded");
                return;
            }
            JSObject out = new JSObject();
            out.put("path", f.getAbsolutePath());
            out.put("mime", "audio/mp4");
            out.put("durationMs", VoiceRecorderService.resultDurationMs);
            out.put("waveform", waveform());
            VoiceRecorderService.resultFile = null;
            VoiceRecorderService.state = "idle";
            call.resolve(out);
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        VoiceRecorderService.send(getContext(), VoiceRecorderService.ACTION_CANCEL);
        call.resolve();
    }

    /** The level samples as WAVEFORM_BARS bars scaled to the loudest (0 to 100), like voice-meta.js. */
    private static JSArray waveform() {
        List<Float> list;
        synchronized (VoiceRecorderService.levels) { list = new ArrayList<>(VoiceRecorderService.levels); }
        JSArray out = new JSArray();
        if (list.isEmpty()) return out;
        float[] bars = new float[WAVEFORM_BARS];
        float top = 0f;
        for (int i = 0; i < WAVEFORM_BARS; i++) {
            int from = (int) Math.floor((double) i * list.size() / WAVEFORM_BARS);
            int to = Math.max(from + 1, (int) Math.floor((double) (i + 1) * list.size() / WAVEFORM_BARS));
            float p = 0f;
            for (int j = from; j < to && j < list.size(); j++) p = Math.max(p, list.get(j));
            bars[i] = p;
            top = Math.max(top, p);
        }
        if (top <= 0f) return out;
        for (float b : bars) out.put(Math.max(4, Math.round(b / top * 100)));
        return out;
    }

    /** Split an M4A into pieces of about `seconds` each, copying the audio as it is. */
    @PluginMethod
    public void splitFile(PluginCall call) {
        String path = call.getString("path");
        int seconds = Math.max(30, call.getInt("seconds", 600));
        if (path == null || !new File(path).exists()) { call.reject("File not found"); return; }
        getBridge().execute(() -> {
            MediaExtractor ex = new MediaExtractor();
            JSArray pieces = new JSArray();
            try {
                ex.setDataSource(path);
                int track = -1;
                MediaFormat format = null;
                for (int i = 0; i < ex.getTrackCount(); i++) {
                    MediaFormat f = ex.getTrackFormat(i);
                    String mime = f.getString(MediaFormat.KEY_MIME);
                    if (mime != null && mime.startsWith("audio/")) { track = i; format = f; break; }
                }
                if (track < 0) { call.reject("No audio in the file"); return; }
                ex.selectTrack(track);
                File dir = new File(getContext().getCacheDir(), "recordings");
                if (!dir.exists()) dir.mkdirs();
                String base = "split-" + System.currentTimeMillis();
                ByteBuffer buf = ByteBuffer.allocate(1 << 20);
                MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
                long pieceUs = seconds * 1_000_000L;
                long pieceStart = 0;
                int index = 0;
                MediaMuxer muxer = null;
                int outTrack = -1;
                File out = null;
                while (true) {
                    int size = ex.readSampleData(buf, 0);
                    if (size < 0) break;
                    long t = ex.getSampleTime();
                    if (muxer == null || t - pieceStart >= pieceUs) {
                        if (muxer != null) { muxer.stop(); muxer.release(); pieces.put(piece(out, pieceStart)); }
                        pieceStart = t;
                        out = new File(dir, base + "-" + (index++) + ".m4a");
                        muxer = new MediaMuxer(out.getAbsolutePath(), MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
                        outTrack = muxer.addTrack(format);
                        muxer.start();
                    }
                    info.set(0, size, t - pieceStart, ex.getSampleFlags() & MediaCodec.BUFFER_FLAG_KEY_FRAME);
                    muxer.writeSampleData(outTrack, buf, info);
                    ex.advance();
                }
                if (muxer != null) { muxer.stop(); muxer.release(); pieces.put(piece(out, pieceStart)); }
                JSObject result = new JSObject();
                result.put("pieces", pieces);
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Couldn't split the recording: " + e.getMessage());
            } finally {
                ex.release();
            }
        });
    }

    private static JSObject piece(File f, long startUs) {
        JSObject o = new JSObject();
        o.put("path", f.getAbsolutePath());
        o.put("offset", startUs / 1_000_000.0);
        return o;
    }
}
