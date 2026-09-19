package com.notetrace.app.wear

import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZonedDateTime
import java.util.Locale

/**
 * A time said out loud, taken out of the sentence.
 *
 * "Remind me to call the plumber tomorrow at nine" should set a reminder, not
 * write the words down. This handles the phrases people actually say to a
 * watch: in twenty minutes, tonight, tomorrow at nine, Friday at half six, at
 * 6pm. Anything cleverer belongs to Trace on the phone.
 *
 * Deliberately local and offline: a reminder set in a dead zone still gets its
 * time, and the note goes up later with the time it was meant to have.
 */
object SpokenTime {

    data class Heard(val text: String, val at: ZonedDateTime?)

    private val WORD_NUMBERS = mapOf(
        "one" to 1, "two" to 2, "three" to 3, "four" to 4, "five" to 5, "six" to 6,
        "seven" to 7, "eight" to 8, "nine" to 9, "ten" to 10, "eleven" to 11, "twelve" to 12,
        "fifteen" to 15, "twenty" to 20, "thirty" to 30, "forty" to 40, "forty-five" to 45,
        "fortyfive" to 45, "sixty" to 60, "ninety" to 90, "half" to 30, "quarter" to 15,
        "a" to 1, "an" to 1,
    )

    private val DAYS = mapOf(
        "monday" to DayOfWeek.MONDAY, "tuesday" to DayOfWeek.TUESDAY, "wednesday" to DayOfWeek.WEDNESDAY,
        "thursday" to DayOfWeek.THURSDAY, "friday" to DayOfWeek.FRIDAY, "saturday" to DayOfWeek.SATURDAY,
        "sunday" to DayOfWeek.SUNDAY,
    )

    /** Parts of the day, as people say them. */
    private val PARTS = mapOf(
        "morning" to LocalTime.of(9, 0),
        "noon" to LocalTime.of(12, 0),
        "midday" to LocalTime.of(12, 0),
        "afternoon" to LocalTime.of(14, 0),
        "evening" to LocalTime.of(18, 0),
        "tonight" to LocalTime.of(20, 0),
        "night" to LocalTime.of(20, 0),
        "midnight" to LocalTime.of(0, 0),
    )

    fun parse(said: String, now: ZonedDateTime = ZonedDateTime.now()): Heard {
        if (said.isBlank()) return Heard(said, null)
        val lower = said.lowercase(Locale.US)

        // "in twenty minutes", "in 2 hours", "in an hour"
        Regex("""\bin\s+(\d+|[a-z-]+)\s+(minute|minutes|min|mins|hour|hours|day|days|week|weeks)\b""")
            .find(lower)?.let { m ->
                val n = number(m.groupValues[1]) ?: return@let
                val at = when (m.groupValues[2].trimEnd('s')) {
                    "minute", "min" -> now.plusMinutes(n.toLong())
                    "hour" -> now.plusHours(n.toLong())
                    "day" -> now.plusDays(n.toLong())
                    else -> now.plusWeeks(n.toLong())
                }
                return Heard(strip(said, m.value), at.withSecond(0).withNano(0))
            }

        // A day, a part of the day, and a clock time, in any combination.
        var day: LocalDate? = null
        var time: LocalTime? = null
        val phrases = mutableListOf<String>()

        Regex("""\btomorrow\b""").find(lower)?.let { day = now.toLocalDate().plusDays(1); phrases += it.value }
        Regex("""\btoday\b""").find(lower)?.let { day = now.toLocalDate(); phrases += it.value }
        if (day == null) {
            Regex("""\b(next\s+)?(${DAYS.keys.joinToString("|")})\b""").find(lower)?.let { m ->
                val target = DAYS[m.groupValues[2]] ?: return@let
                var d = now.toLocalDate().plusDays(1)
                while (d.dayOfWeek != target) d = d.plusDays(1)
                if (m.groupValues[1].isNotBlank() && d.isBefore(now.toLocalDate().plusDays(7))) d = d.plusWeeks(1)
                day = d
                phrases += m.value
            }
        }

        // "at 6", "at 6:30", "at 6 pm", "at half six" (treated as 6:30)
        Regex("""\bat\s+(half\s+|quarter\s+past\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?""")
            .find(lower)?.let { m ->
                val hour = m.groupValues[2].toIntOrNull() ?: return@let
                val minutes = m.groupValues[3].toIntOrNull() ?: if (m.groupValues[1].isNotBlank()) 30 else 0
                time = clock(hour, minutes, m.groupValues[4], now, day)
                phrases += m.value.trim()
            }
        if (time == null) {
            Regex("""\bat\s+([a-z]+)(\s+(am|pm))?\b""").find(lower)?.let { m ->
                val hour = WORD_NUMBERS[m.groupValues[1]] ?: return@let
                if (hour > 12) return@let
                time = clock(hour, 0, m.groupValues[3], now, day)
                phrases += m.value.trim()
            }
        }
        if (time == null) {
            Regex("""\b(this\s+|tomorrow\s+)?(${PARTS.keys.joinToString("|")})\b""").find(lower)?.let { m ->
                time = PARTS[m.groupValues[2]]
                if (m.groupValues[1].trim() == "tomorrow") day = now.toLocalDate().plusDays(1)
                phrases += m.value.trim()
            }
        }

        if (day == null && time == null) return Heard(said, null)

        val date = day ?: now.toLocalDate()
        var at = ZonedDateTime.of(date, time ?: LocalTime.of(9, 0), now.zone)
        // "at six" said at eight in the evening means tomorrow morning, not the past.
        if (day == null && at.isBefore(now)) at = at.plusDays(1)

        var text = said
        for (phrase in phrases) text = strip(text, phrase)
        return Heard(text, at.withSecond(0).withNano(0))
    }

    private fun number(raw: String): Int? = raw.toIntOrNull() ?: WORD_NUMBERS[raw]

    private fun clock(hour: Int, minutes: Int, meridiem: String, now: ZonedDateTime, day: LocalDate?): LocalTime {
        var h = hour % 24
        val mer = meridiem.replace(".", "")
        when {
            mer.startsWith("p") && h < 12 -> h += 12
            mer.startsWith("a") && h == 12 -> h = 0
            // No am or pm: pick the reading that isn't in the past today.
            mer.isBlank() && h in 1..11 && day == null && now.hour >= h + 12 -> h += 12
            mer.isBlank() && h in 1..7 && day == null && now.hour > h -> h += 12
        }
        return LocalTime.of(h.coerceIn(0, 23), minutes.coerceIn(0, 59))
    }

    /** Take the time phrase out, and tidy what's left. */
    private fun strip(text: String, phrase: String): String {
        val cleaned = Regex("(?i)\\b" + Regex.escape(phrase.trim()) + "\\b").replace(text, " ")
        return cleaned
            .replace(Regex("""\s{2,}"""), " ")
            .replace(Regex("""\s+([,.!?])"""), "$1")
            .trim()
            .trim(',', ' ')
    }
}
