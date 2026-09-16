package com.notetrace.app;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Prints a note the app has laid out as a page. The app's WebView can't open a
 * print dialog, so the page goes into an offscreen WebView and from there to
 * Android's print service, whose "Save as PDF" printer makes a PDF.
 */
@CapacitorPlugin(name = "NotePrint")
public class NotePrintPlugin extends Plugin {
    // The print service reads the page after print() returns, so the view has to outlive the call.
    private WebView printView;

    @PluginMethod
    public void print(PluginCall call) {
        String html = call.getString("html");
        String title = call.getString("title", "Note");
        if (html == null || html.isEmpty()) {
            call.reject("Nothing to print");
            return;
        }
        getActivity().runOnUiThread(() -> {
            WebView view = new WebView(getActivity());
            view.getSettings().setJavaScriptEnabled(false);
            view.getSettings().setAllowFileAccess(false);
            view.setWebViewClient(new WebViewClient() {
                private boolean started = false;

                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                    return true;
                }

                @Override
                public void onPageFinished(WebView v, String url) {
                    if (started) return;
                    started = true;
                    try {
                        PrintManager manager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                        manager.print(title, v.createPrintDocumentAdapter(title), new PrintAttributes.Builder().build());
                        call.resolve();
                    } catch (Exception e) {
                        call.reject("Could not open printing", e);
                    }
                }
            });
            printView = view;
            view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
        });
    }
}
