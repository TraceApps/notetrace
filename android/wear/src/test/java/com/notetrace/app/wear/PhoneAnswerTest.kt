package com.notetrace.app.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Local mode: what the watch makes of the phone's reply. */
class PhoneAnswerTest {
    private fun reply(status: Int, body: String) =
        org.json.JSONObject().put("status", status).put("body", body).toString().toByteArray()

    @Test fun anAnswerIsTheBody() {
        assertEquals("[]", NoteApi.readPhoneAnswer(reply(200, "[]")))
    }

    @Test fun anAppNotReadyOrTooSlowWaitsLikeNoConnection() {
        for (status in listOf(503, 504)) {
            try { NoteApi.readPhoneAnswer(reply(status, "{}")); fail() } catch (e: NoteApi.PhoneUnavailable) {
                assertEquals("Open NoteTrace on your phone", e.message)
            }
        }
        try { NoteApi.readPhoneAnswer("not json".toByteArray()); fail() } catch (e: NoteApi.PhoneUnavailable) { }
    }

    @Test fun aRefusalSaysWhyAndIsNotSignedOut() {
        try { NoteApi.readPhoneAnswer(reply(409, "{\"error\":\"The phone is connected to a server now.\"}")); fail() } catch (e: NoteApi.ApiError) {
            assertEquals(409, e.status)
            assertEquals("The phone is connected to a server now.", e.message)
            assertTrue(e.status != 401 && e.status != 403)
        }
    }

    @Test fun theAddressMatchesThePhones() {
        assertEquals("phone:", Pairing.PHONE)
        assertTrue(Pairing.Config(Pairing.PHONE, "local").viaPhone)
        assertTrue(!Pairing.Config("https://note.example", "t").viaPhone)
    }
}
