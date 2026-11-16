package com.chesscoach.app

import com.chesscoach.app.BrowserNavigationPolicy.Destination
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowserNavigationPolicyTest {
    @Test
    fun keepsGameAndPasswordLoginInTheSameBrowserSession() {
        for (url in listOf("https://lichess.org/", "https://www.chess.com/play/online", "https://chess.com/login", "https://WWW.CHESS.COM:443/login")) {
            assertEquals(url, Destination.GAME, BrowserNavigationPolicy.classify(url))
        }
        assertTrue(BrowserNavigationPolicy.isAccountPage(BrowserNavigationPolicy.CHESS_COM_LOGIN))
        assertTrue(BrowserNavigationPolicy.isAccountPage("https://lichess.org/signup"))
        assertTrue(BrowserNavigationPolicy.isAccountPage("https://www.chess.com/account/reset-password"))
        assertFalse(BrowserNavigationPolicy.isAccountPage("https://www.chess.com/play/online"))
        assertFalse(BrowserNavigationPolicy.isAccountPage("https://example.com/login"))
    }

    @Test
    fun doesNotContinueWebViewGoogleOAuthInAnotherCookieJar() {
        for (url in listOf("https://accounts.google.com/o/oauth2/v2/auth?state=test", "https://www.chess.com/login/google", "https://www.chess.com/oauth/google/callback")) {
            assertEquals(url, Destination.GOOGLE_AUTH, BrowserNavigationPolicy.classify(url))
        }
        assertEquals(Destination.WEB, BrowserNavigationPolicy.classify("https://accounts.google.com.attacker.test/login"))
        assertEquals(Destination.GAME, BrowserNavigationPolicy.classify("https://www.chess.com/article/google"))
    }

    @Test
    fun isolatesOtherWebsitesAndOnlyAllowsTheLocalCreditsDocument() {
        assertEquals(Destination.WEB, BrowserNavigationPolicy.classify("https://t.me/chesscoach_dev"))
        assertEquals(Destination.WEB, BrowserNavigationPolicy.classify("https://appleid.apple.com/auth/authorize"))
        assertEquals(Destination.CREDITS, BrowserNavigationPolicy.classify(BrowserNavigationPolicy.CREDITS_URL + "#thanks"))
        assertEquals(Destination.BLOCKED, BrowserNavigationPolicy.classify("https://appassets.androidplatform.net/assets/engine/engine-host.html"))
        assertEquals(Destination.BLOCKED, BrowserNavigationPolicy.classify(BrowserNavigationPolicy.CREDITS_URL + "?redirect=example"))
    }

    @Test
    fun rejectsUnsafeSchemesAuthoritiesAndLookalikeGameHosts() {
        for (url in listOf("http://www.chess.com/login", "javascript:alert(1)", "file:///data/data/app", "content://settings", "intent://login", "https://www.chess.com@attacker.test/", "https://user:password@www.chess.com/", "https://www.chess.com:8443/", "https://www.chess.com\\@attacker.test/", "https://www.chess.com/\nlogin", "https:///www.chess.com", "")) {
            assertEquals(url, Destination.BLOCKED, BrowserNavigationPolicy.classify(url))
        }
        assertEquals(Destination.WEB, BrowserNavigationPolicy.classify("https://www.chess.com.attacker.test/"))
        assertEquals(Destination.EXTERNAL_APP, BrowserNavigationPolicy.classify("mailto:hello@example.com"))
    }
}
