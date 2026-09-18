package com.notetrace.app.wear

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Intent
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.MonochromaticImage
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import androidx.wear.watchface.complications.datasource.SuspendingComplicationDataSourceService

/**
 * The count on the watch face: what's due, or what's left to buy.
 *
 * Reads the snapshot the app saved, so it costs nothing and is right as of the
 * last time the app or tile refreshed. Tapping it opens NoteTrace.
 */
class ListComplicationService : SuspendingComplicationDataSourceService() {

    companion object {
        /** The counts changed: redraw whatever watch face is showing them. */
        fun refresh(ctx: android.content.Context) {
            runCatching {
                androidx.wear.watchface.complications.datasource.ComplicationDataSourceUpdateRequester
                    .create(ctx, ComponentName(ctx, ListComplicationService::class.java))
                    .requestUpdateAll()
            }
        }
    }

    override fun getPreviewData(type: ComplicationType): ComplicationData? =
        if (type != ComplicationType.SHORT_TEXT) null
        else shortText("3", "Buy", "3 left to buy")

    override suspend fun onComplicationRequest(request: ComplicationRequest): ComplicationData? {
        if (request.complicationType != ComplicationType.SHORT_TEXT) return null
        val snap = Pairing.cache(this)

        var toBuy = 0
        val shopping = snap?.optJSONArray("shopping")
        for (i in 0 until (shopping?.length() ?: 0)) {
            if (!shopping!!.getJSONObject(i).optBoolean("checked")) toBuy++
        }

        var due = 0
        val reminders = snap?.optJSONArray("reminders")
        for (i in 0 until (reminders?.length() ?: 0)) {
            val at = reminders!!.getJSONObject(i).optString("reminder_at")
            if (at.isNotBlank() && WhenText.isOverdue(at)) due++
        }

        // What needs doing now beats what needs buying later.
        return when {
            due > 0 -> shortText(due.toString(), "Due", "$due reminders due")
            toBuy > 0 -> shortText(toBuy.toString(), "Buy", "$toBuy left to buy")
            else -> shortText("0", "Buy", "Nothing waiting")
        }
    }

    private fun shortText(text: String, title: String, description: String): ComplicationData =
        ShortTextComplicationData.Builder(
            text = PlainComplicationText.Builder(text).build(),
            contentDescription = PlainComplicationText.Builder(description).build(),
        )
            .setTitle(PlainComplicationText.Builder(title).build())
            .setMonochromaticImage(
                MonochromaticImage.Builder(
                    android.graphics.drawable.Icon.createWithResource(this, R.drawable.ic_complication),
                ).build(),
            )
            .setTapAction(openApp())
            .build()

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent().apply {
            component = ComponentName(packageName, MainActivity::class.java.name)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        },
        PendingIntent.FLAG_IMMUTABLE,
    )
}
