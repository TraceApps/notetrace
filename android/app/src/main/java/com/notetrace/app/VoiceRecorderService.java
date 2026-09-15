package com.notetrace.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * Records a voice note in a foreground service, so recording carries on with
 * the screen off or another app in front. AAC in M4A, mono at 32 kbps: three
 * hours comes to about 43 MB. A notification shows it's recording, with Pause
 * or Resume and Stop.
 *
 * VoiceRecorderPlugin starts it and reads its state; the result (file, length,
 * waveform levels) waits in static fields until the plugin collects it.
 */
public class VoiceRecorderService extends Service {
    private static final String TAG = "VoiceRecorder";
    static final String CHANNEL_ID = "voice_recording";
    static final int NOTIFICATION_ID = 7342;
    static final long MAX_MS = 3L * 60 * 60 * 1000;

    static final String ACTION_START = "com.notetrace.app.voice.START";
    static final String ACTION_PAUSE = "com.notetrace.app.voice.PAUSE";
    static final String ACTION_RESUME = "com.notetrace.app.voice.RESUME";
    static final String ACTION_STOP = "com.notetrace.app.voice.STOP";
    static final String ACTION_CANCEL = "com.notetrace.app.voice.CANCEL";

    // Shared with the plugin. "idle", "starting", "recording", "paused", "stopped", "error".
    static volatile String state = "idle";
    static volatile String error = null;
    static volatile File resultFile = null;
    static volatile long resultDurationMs = 0;
    static final List<Float> levels = new ArrayList<>();
    private static volatile float peak = 0f;

    private MediaRecorder recorder;
    private File file;
    private long startedAt;
    private long pausedAt;
    private long pausedTotal;
    private PowerManager.WakeLock wakeLock;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private static volatile VoiceRecorderService current;

    private final Runnable sampler = new Runnable() {
        @Override
        public void run() {
            if (recorder != null && "recording".equals(state)) {
                float level = 0f;
                try { level = Math.min(1f, recorder.getMaxAmplitude() / 32767f * 1.6f); } catch (Exception ignored) { }
                peak = Math.max(peak, level);
                synchronized (levels) { if (levels.size() < 60000) levels.add(level); }
                if (elapsedMs() >= MAX_MS) { finish(); return; }
            }
            handler.postDelayed(this, 200);
        }
    };

    static void send(Context ctx, String action) {
        Intent i = new Intent(ctx, VoiceRecorderService.class).setAction(action);
        if (ACTION_START.equals(action)) ContextCompat.startForegroundService(ctx, i);
        else ctx.startService(i);
    }

    /** Milliseconds recorded so far, pauses left out. */
    static long currentElapsedMs() {
        VoiceRecorderService s = current;
        return s != null ? s.elapsedMs() : resultDurationMs;
    }

    /** The loudest level since the last call (0 to 1). */
    static float takePeak() { float p = peak; peak = 0f; return p; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_START.equals(action)) begin();
        else if (ACTION_PAUSE.equals(action)) pause();
        else if (ACTION_RESUME.equals(action)) resume();
        else if (ACTION_STOP.equals(action)) finish();
        else if (ACTION_CANCEL.equals(action)) cancel();
        return START_NOT_STICKY;
    }

    private void begin() {
        if (recorder != null) return;
        current = this;
        state = "starting";
        error = null;
        resultFile = null;
        resultDurationMs = 0;
        synchronized (levels) { levels.clear(); }
        createChannel();
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(),
                Build.VERSION.SDK_INT >= 30 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0);
        } catch (Exception e) {
            fail("Couldn't start recording in the background: " + e.getMessage());
            return;
        }
        File dir = new File(getCacheDir(), "recordings");
        if (!dir.exists() && !dir.mkdirs()) { fail("Couldn't create a place to record"); return; }
        cleanOld(dir);
        file = new File(dir, "voice-" + System.currentTimeMillis() + ".m4a");
        try {
            recorder = Build.VERSION.SDK_INT >= 31 ? new MediaRecorder(this) : new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioChannels(1);
            recorder.setAudioSamplingRate(22050);
            recorder.setAudioEncodingBitRate(32000);
            recorder.setOutputFile(file.getAbsolutePath());
            recorder.prepare();
            recorder.start();
        } catch (Exception e) {
            Log.w(TAG, "start failed: " + e.getMessage());
            releaseRecorder();
            if (file != null) file.delete();
            fail("The microphone isn't available");
            return;
        }
        startedAt = SystemClock.elapsedRealtime();
        pausedTotal = 0;
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NoteTrace:voice");
            wakeLock.acquire(MAX_MS + 60_000);
        }
        state = "recording";
        handler.post(sampler);
        updateNotification();
    }

    private long elapsedMs() {
        if (startedAt == 0) return 0;
        long end = "paused".equals(state) ? pausedAt : SystemClock.elapsedRealtime();
        return Math.max(0, end - startedAt - pausedTotal);
    }

    private void pause() {
        if (recorder == null || !"recording".equals(state)) return;
        try { recorder.pause(); } catch (Exception e) { return; }
        pausedAt = SystemClock.elapsedRealtime();
        state = "paused";
        updateNotification();
    }

    private void resume() {
        if (recorder == null || !"paused".equals(state)) return;
        try { recorder.resume(); } catch (Exception e) { return; }
        pausedTotal += SystemClock.elapsedRealtime() - pausedAt;
        state = "recording";
        updateNotification();
    }

    private void finish() {
        if (recorder == null) return;
        long duration = elapsedMs();
        boolean ok = true;
        try { recorder.stop(); } catch (RuntimeException e) { ok = false; }
        releaseRecorder();
        if (!ok || file == null || !file.exists() || file.length() == 0) {
            if (file != null) file.delete();
            resultFile = null;
            fail("Nothing was recorded");
        } else {
            resultFile = file;
            resultDurationMs = duration;
            state = "stopped";
        }
        shutDown();
    }

    private void cancel() {
        if (recorder != null) {
            try { recorder.stop(); } catch (RuntimeException ignored) { }
            releaseRecorder();
        }
        if (file != null) file.delete();
        resultFile = null;
        state = "idle";
        shutDown();
    }

    private void fail(String message) {
        error = message;
        state = "error";
        shutDown();
    }

    private void releaseRecorder() {
        if (recorder != null) {
            try { recorder.release(); } catch (Exception ignored) { }
            recorder = null;
        }
    }

    private void shutDown() {
        handler.removeCallbacks(sampler);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        current = null;
        stopSelf();
    }

    /** Recordings the app never collected (it was closed mid-recording) go after a day. */
    private static void cleanOld(File dir) {
        File[] old = dir.listFiles();
        if (old == null) return;
        long cutoff = System.currentTimeMillis() - 24L * 3600 * 1000;
        for (File f : old) if (f.lastModified() < cutoff) f.delete();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Voice recording", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Shows while NoteTrace is recording a voice note");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    private PendingIntent action(String action, int code) {
        Intent i = new Intent(this, VoiceRecorderService.class).setAction(action);
        return PendingIntent.getService(this, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        boolean paused = "paused".equals(state);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_notetrace)
            .setContentTitle(paused ? "Voice note paused" : "Recording a voice note")
            .setContentText(paused ? "Tap Resume to keep going" : "Keeps recording with the screen off")
            .setContentIntent(content)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        if (!paused && startedAt > 0) {
            b.setUsesChronometer(true).setWhen(System.currentTimeMillis() - elapsedMs()).setShowWhen(true);
        }
        b.addAction(0, paused ? "Resume" : "Pause", action(paused ? ACTION_RESUME : ACTION_PAUSE, 1));
        b.addAction(0, "Stop", action(ACTION_STOP, 2));
        return b.build();
    }

    private void updateNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null && (recorder != null)) nm.notify(NOTIFICATION_ID, buildNotification());
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The app was swiped away: keep what was recorded.
        finish();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        if (recorder != null) finish();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
