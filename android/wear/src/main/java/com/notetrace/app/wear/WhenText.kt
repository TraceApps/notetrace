package com.notetrace.app.wear

import android.text.format.DateFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

/**
 * When a reminder is due, in the fewest words that still say it.
 *
 * A watch face has room for "Today 6:30 PM", not "Wednesday, 18 September at
 * 6:30 PM", and the wearer nearly always wants today, tomorrow, or the weekday.
 */
object WhenText {

    fun due(iso: String, is24Hour: Boolean, now: ZonedDateTime = ZonedDateTime.now()): String {
        val at = parse(iso) ?: return ""
        val local = at.withZoneSameInstant(ZoneId.systemDefault())
        val today = now.toLocalDate()
        val day = local.toLocalDate()
        val time = local.format(DateTimeFormatter.ofPattern(if (is24Hour) "HH:mm" else "h:mm a", Locale.getDefault()))
        return when {
            day.isBefore(today) -> "Overdue, " + time
            day == today -> "Today " + time
            day == today.plusDays(1) -> "Tomorrow " + time
            day.isBefore(today.plusDays(7)) ->
                day.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.getDefault()) + " " + time
            day.year == today.year ->
                day.format(DateTimeFormatter.ofPattern("d MMM", Locale.getDefault())) + " " + time
            else -> day.format(DateTimeFormatter.ofPattern("d MMM yyyy", Locale.getDefault()))
        }
    }

    /** True when the reminder has already come due. */
    fun isOverdue(iso: String, now: ZonedDateTime = ZonedDateTime.now()): Boolean {
        val at = parse(iso) ?: return false
        return at.toInstant().isBefore(now.toInstant())
    }

    /** The server sends either an ISO instant or "YYYY-MM-DD HH:MM:SS" in UTC. */
    private fun parse(iso: String): ZonedDateTime? {
        if (iso.isBlank()) return null
        return runCatching { ZonedDateTime.parse(iso) }.getOrNull()
            ?: runCatching { Instant.parse(iso).atZone(ZoneId.of("UTC")) }.getOrNull()
            ?: runCatching {
                val cleaned = iso.trim().replace(' ', 'T')
                Instant.parse(if (cleaned.endsWith("Z")) cleaned else cleaned + "Z").atZone(ZoneId.of("UTC"))
            }.getOrNull()
    }

    fun is24Hour(ctx: android.content.Context): Boolean = DateFormat.is24HourFormat(ctx)

    /** Only the date part, for grouping. */
    fun dayOf(iso: String): LocalDate? =
        parse(iso)?.withZoneSameInstant(ZoneId.systemDefault())?.toLocalDate()
}
