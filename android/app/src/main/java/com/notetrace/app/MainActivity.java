package com.notetrace.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    // Capacitor's BridgeActivity does all the WebView setup. NoteTrace
    // doesn't yet ship native background workers — when notification
    // features land (cook reminders, thaw alerts, etc.), enqueue the
    // schedulers from onCreate here.
}
