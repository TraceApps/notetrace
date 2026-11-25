package com.notetrace.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NoteReminderIdTest {
    @Test public void acceptsNoteAndTaskDigestIds() {
        assertTrue(NoteReminderScheduler.isValidReminderId(42));
        for (long id = -100; id >= -113; id--) {
            assertTrue(NoteReminderScheduler.isValidReminderId(id));
        }
    }

    @Test public void rejectsMissingAndUnassignedNegativeIds() {
        assertFalse(NoteReminderScheduler.isValidReminderId(NoteReminderScheduler.MISSING_NOTE_ID));
        assertFalse(NoteReminderScheduler.isValidReminderId(-99));
        assertFalse(NoteReminderScheduler.isValidReminderId(-114));
        assertFalse(NoteReminderScheduler.isValidReminderId(Long.MIN_VALUE));
    }
}
