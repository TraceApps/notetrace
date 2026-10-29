package com.notetrace.app;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    /** The app's own links: notetrace://new/<kind> from the shortcuts, widget and tile. */
    static final String LINK_SCHEME = "notetrace";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Reopened from Recents, a shortcut's link that started the app is not
        // a new tap: drop it before the bridge reads the launch URL.
        AppShortcutActivity.dropReplayedLink(this, savedInstanceState);
        registerPlugin(ShareIntentPlugin.class);
        registerPlugin(NoteRemindersPlugin.class);
        registerPlugin(FoldPlugin.class);
        registerPlugin(VoiceRecorderPlugin.class);
        registerPlugin(NotePrintPlugin.class);
        registerPlugin(NoteWidgetPlugin.class);
        registerPlugin(WearPairingPlugin.class);
        registerPlugin(InstallMarkerPlugin.class);
        super.onCreate(savedInstanceState);
        ShareIntentPlugin.handleIntent(getIntent());
        NoteRemindersPlugin.handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        ShareIntentPlugin.handleIntent(intent);
        NoteRemindersPlugin.handleIntent(intent);
    }
}
