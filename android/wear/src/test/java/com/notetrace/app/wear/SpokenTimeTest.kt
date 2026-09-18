package com.notetrace.app.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

/** What people say to a watch, and the reminder it should set. */
class SpokenTimeTest {

    // A Wednesday, mid-afternoon.
    private val now = ZonedDateTime.of(2026, 9, 16, 15, 20, 0, 0, ZoneId.of("UTC"))

    private fun at(said: String) = SpokenTime.parse(said, now).at
    private fun text(said: String) = SpokenTime.parse(said, now).text

    @Test fun `in twenty minutes`() {
        assertEquals(now.plusMinutes(20), at("call the plumber in twenty minutes"))
        assertEquals("call the plumber", text("call the plumber in twenty minutes"))
    }

    @Test fun `in two hours, in digits`() {
        assertEquals(now.plusHours(2), at("take the bread out in 2 hours"))
    }

    @Test fun `tomorrow at nine`() {
        val expected = now.plusDays(1).withHour(9).withMinute(0).withSecond(0).withNano(0)
        assertEquals(expected, at("call the plumber tomorrow at nine"))
        assertEquals("call the plumber", text("call the plumber tomorrow at nine"))
    }

    @Test fun `tonight means this evening`() {
        assertEquals(now.withHour(20).withMinute(0).withSecond(0).withNano(0), at("bins out tonight"))
        assertEquals("bins out", text("bins out tonight"))
    }

    @Test fun `a time already past today means tomorrow`() {
        // Said at 15:20, "at 9" can only sensibly mean tomorrow morning.
        assertEquals(now.plusDays(1).withHour(9).withMinute(0).withSecond(0).withNano(0), at("dentist at 9"))
    }

    @Test fun `pm is taken at its word`() {
        assertEquals(now.withHour(18).withMinute(30).withSecond(0).withNano(0), at("dinner at 6:30 pm"))
    }

    @Test fun `an afternoon hour needs no pm`() {
        // "at 4" said at 15:20 means 16:00 today, not four in the morning.
        assertEquals(now.withHour(16).withMinute(0).withSecond(0).withNano(0), at("tea at 4"))
    }

    @Test fun `a weekday means the next one`() {
        // Wednesday, so Friday is two days out.
        assertEquals(now.plusDays(2).withHour(9).withMinute(0).withSecond(0).withNano(0), at("pay the rent on friday"))
    }

    @Test fun `a weekday with a time`() {
        assertEquals(now.plusDays(2).withHour(8).withMinute(0).withSecond(0).withNano(0), at("gym friday at 8"))
        assertEquals("gym", text("gym friday at 8"))
    }

    @Test fun `no time said, nothing set`() {
        assertNull(at("buy stamps"))
        assertEquals("buy stamps", text("buy stamps"))
    }

    @Test fun `a number in the note is not a time`() {
        assertNull(at("order 6 chairs"))
    }

    @Test fun `nothing said at all`() {
        assertNull(at(""))
    }
}
