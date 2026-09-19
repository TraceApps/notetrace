package com.notetrace.app.wear

import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DimensionBuilders.dp
import androidx.wear.protolayout.DimensionBuilders.sp
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.LayoutElementBuilders.Column
import androidx.wear.protolayout.LayoutElementBuilders.FONT_WEIGHT_BOLD
import androidx.wear.protolayout.LayoutElementBuilders.FontStyle
import androidx.wear.protolayout.LayoutElementBuilders.HORIZONTAL_ALIGN_CENTER
import androidx.wear.protolayout.LayoutElementBuilders.Spacer
import androidx.wear.protolayout.LayoutElementBuilders.Text
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * A tile: what's left to buy and what's due, one swipe from the watch face.
 *
 * Drawn from the snapshot the app saved, so it appears instantly and works with
 * no connection. Tapping it opens the app, which refreshes from the server.
 */
class ListTileService : TileService() {

    override fun onTileResourcesRequest(
        requestParams: RequestBuilders.ResourcesRequest,
    ): ListenableFuture<ResourceBuilders.Resources> =
        Futures.immediateFuture(ResourceBuilders.Resources.Builder().setVersion(RES_VERSION).build())

    override fun onTileRequest(
        requestParams: RequestBuilders.TileRequest,
    ): ListenableFuture<TileBuilders.Tile> {
        val snap = Pairing.cache(this)
        val paired = Pairing.config(this) != null

        val shopping = snap?.optJSONArray("shopping")
        var toBuy = 0
        for (i in 0 until (shopping?.length() ?: 0)) {
            if (!shopping!!.getJSONObject(i).optBoolean("checked")) toBuy++
        }

        val reminders = snap?.optJSONArray("reminders")
        var due = 0
        var next = ""
        for (i in 0 until (reminders?.length() ?: 0)) {
            val at = reminders!!.getJSONObject(i).optString("reminder_at")
            if (at.isBlank()) continue
            if (WhenText.isOverdue(at)) due++
            else if (next.isBlank() || at < next) next = at
        }

        val headline: String
        val detail: String
        when {
            !paired -> {
                headline = "NoteTrace"
                detail = "Pair from your phone"
            }
            due > 0 -> {
                headline = if (due == 1) "1 reminder due" else "$due reminders due"
                detail = if (toBuy > 0) "$toBuy to buy" else "Tap to open"
            }
            toBuy > 0 -> {
                headline = if (toBuy == 1) "1 to buy" else "$toBuy to buy"
                detail = if (next.isNotBlank()) WhenText.due(next, WhenText.is24Hour(this)) else "Shopping list"
            }
            next.isNotBlank() -> {
                headline = "Next reminder"
                detail = WhenText.due(next, WhenText.is24Hour(this))
            }
            else -> {
                headline = "NoteTrace"
                detail = "Nothing waiting"
            }
        }

        val openApp = ModifiersBuilders.Modifiers.Builder()
            .setClickable(
                ModifiersBuilders.Clickable.Builder()
                    .setId("open")
                    .setOnClick(
                        ActionBuilders.LaunchAction.Builder()
                            .setAndroidActivity(
                                ActionBuilders.AndroidActivity.Builder()
                                    .setPackageName(packageName)
                                    .setClassName(MainActivity::class.java.name)
                                    .build(),
                            )
                            .build(),
                    )
                    .build(),
            )
            .build()

        val layout = Column.Builder()
            .setModifiers(openApp)
            .setHorizontalAlignment(HORIZONTAL_ALIGN_CENTER)
            .addContent(
                Text.Builder()
                    .setText("NoteTrace")
                    .setFontStyle(FontStyle.Builder().setSize(sp(13f)).setColor(argb(0xFFB69CFF.toInt())).build())
                    .build(),
            )
            .addContent(Spacer.Builder().setHeight(dp(6f)).build())
            .addContent(
                Text.Builder()
                    .setText(headline)
                    .setMaxLines(2)
                    .setFontStyle(
                        FontStyle.Builder().setSize(sp(20f)).setWeight(FONT_WEIGHT_BOLD)
                            .setColor(argb(0xFFFFFFFF.toInt())).build(),
                    )
                    .build(),
            )
            .addContent(Spacer.Builder().setHeight(dp(4f)).build())
            .addContent(
                Text.Builder()
                    .setText(detail)
                    .setMaxLines(2)
                    .setFontStyle(FontStyle.Builder().setSize(sp(14f)).setColor(argb(0xFFB6BAC6.toInt())).build())
                    .build(),
            )
            .build()

        val tile = TileBuilders.Tile.Builder()
            .setResourcesVersion(RES_VERSION)
            // The app refreshes this snapshot whenever it opens; ten minutes keeps
            // the tile honest without waking anything.
            .setFreshnessIntervalMillis(10 * 60 * 1000)
            .setTileTimeline(
                TimelineBuilders.Timeline.Builder()
                    .addTimelineEntry(
                        TimelineBuilders.TimelineEntry.Builder()
                            .setLayout(
                                LayoutElementBuilders.Layout.Builder().setRoot(layout).build(),
                            )
                            .build(),
                    )
                    .build(),
            )
            .build()
        return Futures.immediateFuture(tile)
    }

    companion object {
        private const val RES_VERSION = "1"

        /** Ask the system to redraw the tile after the app saves a new snapshot. */
        fun refresh(ctx: android.content.Context) {
            runCatching { getUpdater(ctx).requestUpdate(ListTileService::class.java) }
        }
    }
}
