package com.notetrace.app;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShareIntentPlugin.class);
        registerPlugin(NoteRemindersPlugin.class);
        registerPlugin(FoldPlugin.class);
        registerPlugin(VoiceRecorderPlugin.class);
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
