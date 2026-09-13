package com.notetrace.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;

import org.junit.Test;

/** Same cases as scripts/reminders.test.js, so the Java and JS math agree. */
public class ReminderMathTest {
    private static final String NY = "America/New_York";

    private static long iso(String s) { return Instant.parse(s).toEpochMilli(); }
    private static String isoOf(Long ms) { return ms == null ? null : Instant.ofEpochMilli(ms).toString(); }
    private static String zoned(int y, int m, int d, int h, int min) {
        return ReminderMath.toUtcString(LocalDateTime.of(y, m, d, h, min).atZone(ZoneId.of(NY)).toInstant().toEpochMilli());
    }

    @Test public void oneOffReturnsItsOwnTimeEvenWhenPast() {
        assertEquals("2026-01-05T13:00:00Z", isoOf(ReminderMath.nextOccurrence("2026-01-05 13:00:00", null, NY, iso("2026-03-01T00:00:00Z"))));
    }

    @Test public void dailyKeepsWallClockAcrossSpringDst() {
        String anchor = zoned(2026, 1, 5, 8, 0);
        assertEquals("2026-01-05 13:00:00", anchor);
        assertEquals("2026-03-21T12:00:00Z", isoOf(ReminderMath.nextOccurrence(anchor, "daily", NY, iso("2026-03-20T15:00:00Z"))));
    }

    @Test public void dailyFiresLaterTodayWhenNotPassed() {
        String anchor = zoned(2026, 1, 5, 20, 30);
        assertEquals("2026-03-21T00:30:00Z", isoOf(ReminderMath.nextOccurrence(anchor, "daily", NY, iso("2026-03-20T15:00:00Z"))));
    }

    @Test public void weeklyStaysOnTheSameWeekday() {
        String anchor = zoned(2026, 9, 7, 9, 0);
        assertEquals("2026-09-21T13:00:00Z", isoOf(ReminderMath.nextOccurrence(anchor, "weekly", NY, iso("2026-09-16T12:00:00Z"))));
    }

    @Test public void monthlyClampsTheThirtyFirst() {
        String anchor = zoned(2026, 1, 31, 9, 0);
        assertEquals("2026-02-28T14:00:00Z", isoOf(ReminderMath.nextOccurrence(anchor, "monthly", NY, iso("2026-02-10T12:00:00Z"))));
    }

    @Test public void yearlyRollsToNextYear() {
        String anchor = zoned(2025, 9, 13, 10, 0);
        assertEquals("2027-09-13T14:00:00Z", isoOf(ReminderMath.nextOccurrence(anchor, "yearly", NY, iso("2026-09-14T00:00:00Z"))));
    }

    @Test public void dueOccurrenceRespectsTheWindow() {
        long window = 10 * 60 * 1000L;
        assertEquals("2026-03-10T14:00:00Z", isoOf(ReminderMath.dueOccurrence("2026-03-10 14:00:00", null, NY, iso("2026-03-10T14:05:00Z"), window)));
        assertNull(ReminderMath.dueOccurrence("2026-03-10 14:00:00", null, NY, iso("2026-03-10T13:59:00Z"), window));
        assertNull(ReminderMath.dueOccurrence("2026-03-10 14:00:00", null, NY, iso("2026-03-10T14:20:00Z"), window));
    }

    @Test public void parsesIsoAndRejectsGarbage() {
        assertEquals("2026-03-10T14:00:00Z", isoOf(ReminderMath.parseUtc("2026-03-10T14:00:00.000Z")));
        assertNull(ReminderMath.parseUtc("not a date"));
        assertNull(ReminderMath.nextOccurrence(null, "daily", NY, 0L));
    }
}
