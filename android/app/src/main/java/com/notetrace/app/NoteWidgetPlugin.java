package com.notetrace.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * NoteWidget: the app sends the Notes widget what to show.
 *
 *   update({ locked, notes: [{ id, title, text, color, pinned }] })
 */
@CapacitorPlugin(name = "NoteWidget")
public class NoteWidgetPlugin extends Plugin {
    @PluginMethod
    public void update(PluginCall call) {
        JSObject data = call.getData();
        NoteWidgetStore.save(getContext(), data.toString());
        NoteWidgetStore.refreshAll(getContext());
        call.resolve();
    }
}
