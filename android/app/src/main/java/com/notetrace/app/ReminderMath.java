package com.notetrace.app;

import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Reminder repeat math, a Java port of nextOccurrence in
 * src/lib/reminders.js (kept in step by ReminderMathTest, which uses the
 * same cases as scripts/reminders.test.js).
 *
 * A reminder is its first occurrence in UTC, a repeat, and the IANA zone it
 * was set in. Repeats keep the wall-clock time in that zone, so an 8:00 AM
 * daily reminder stays at 8:00 AM across daylight saving changes, and a
 * monthly reminder on the 31st lands on the last day of shorter months.
 */
public final class ReminderMath {
    public static final Set<String> REPEATS = new HashSet<>(Arrays.asList("daily", "weekly", "monthly", "yearly"));
    private static final DateTimeFormatter SQL = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private ReminderMath() {}

    /** Parse the stored 'YYYY-MM-DD HH:MM:SS' UTC (or ISO) time. Null when unparseable. */
    public static Long parseUtc(String s) {
        if (s == null || s.trim().isEmpty()) return null;
        String v = s.trim();
        try {
            if (v.contains("T")) {
                return Instant.parse(v.endsWith("Z") || v.matches(".*[+-]\\d\\d:?\\d\\d$") ? v : v + "Z").toEpochMilli();
            }
            return LocalDateTime.parse(v.length() > 19 ? v.substring(0, 19) : v, SQL).atZone(ZoneId.of("UTC")).toInstant().toEpochMilli();
        } catch (Exception e) {
            return null;
        }
    }

    public static String toUtcString(long ms) {
        return LocalDateTime.ofInstant(Instant.ofEpochMilli(ms), ZoneId.of("UTC")).format(SQL);
    }

    private static ZoneId zone(String tz) {
        try {
            if (tz != null && !tz.isEmpty()) return ZoneId.of(tz);
        } catch (Exception ignored) { }
        return ZoneId.systemDefault();
    }

    /**
     * The next time the reminder fires. One-off reminders return their single
     * time (even when past); repeating ones return the first occurrence
     * strictly after {@code fromMs}.
     */
    public static Long nextOccurrence(String reminderAt, String repeat, String tz, long fromMs) {
        Long anchorMs = parseUtc(reminderAt);
        if (anchorMs == null) return null;
        if (repeat == null || !REPEATS.contains(repeat)) return anchorMs;
        if (anchorMs > fromMs) return anchorMs;

        ZoneId z = zone(tz);
        ZonedDateTime anchor = Instant.ofEpochMilli(anchorMs).atZone(z);
        LocalTime time = LocalTime.of(anchor.getHour(), anchor.getMinute());
        LocalDate today = Instant.ofEpochMilli(fromMs).atZone(z).toLocalDate();

        switch (repeat) {
            case "daily": {
                LocalDate d = today;
                long c = at(d, time, z);
                for (int i = 0; c <= fromMs && i < 3; i++) { d = d.plusDays(1); c = at(d, time, z); }
                return c;
            }
            case "weekly": {
                DayOfWeek want = anchor.getDayOfWeek();
                int delta = (want.getValue() - today.getDayOfWeek().getValue() + 7) % 7;
                LocalDate d = today.plusDays(delta);
                long c = at(d, time, z);
                if (c <= fromMs) c = at(d.plusDays(7), time, z);
                return c;
            }
            case "monthly": {
                long c = at(clamp(today.getYear(), today.getMonthValue(), anchor.getDayOfMonth()), time, z);
                if (c <= fromMs) {
                    LocalDate next = today.withDayOfMonth(1).plusMonths(1);
                    c = at(clamp(next.getYear(), next.getMonthValue(), anchor.getDayOfMonth()), time, z);
                }
                return c;
            }
            default: { // yearly
                long c = at(clamp(today.getYear(), anchor.getMonthValue(), anchor.getDayOfMonth()), time, z);
                if (c <= fromMs) c = at(clamp(today.getYear() + 1, anchor.getMonthValue(), anchor.getDayOfMonth()), time, z);
                return c;
            }
        }
    }

    /**
     * The occurrence due at {@code nowMs}: passed, but no more than
     * {@code windowMs} ago. Null when nothing is due.
     */
    public static Long dueOccurrence(String reminderAt, String repeat, String tz, long nowMs, long windowMs) {
        Long occ = nextOccurrence(reminderAt, repeat, tz, nowMs - windowMs);
        if (occ == null) return null;
        long age = nowMs - occ;
        return age >= 0 && age <= windowMs ? occ : null;
    }

    private static LocalDate clamp(int year, int month, int day) {
        LocalDate first = LocalDate.of(year, month, 1);
        return first.withDayOfMonth(Math.min(day, first.lengthOfMonth()));
    }

    private static long at(LocalDate date, LocalTime time, ZoneId z) {
        return ZonedDateTime.of(date, time, z).toInstant().toEpochMilli();
    }
}
