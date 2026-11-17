package com.chesscoach.app

import com.chesscoach.app.BrowserNavigationPolicy.Destination
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
    fun classifiesGoogleOAuthForBlockingBeforeTheProviderError() {
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

    @Test
    fun keepsTheCompletedChessComAuthenticationBrowsingContextOnReturn() {
        for (url in listOf("https://www.chess.com/home", "https://chess.com/home", "https://www.chess.com/home#section", "https://www.chess.com/play/online")) {
            assertTrue(BrowserNavigationPolicy.canAdoptAuthenticationWindow(url, true, 100))
            assertFalse(BrowserNavigationPolicy.canAdoptAuthenticationWindow(url, false, 100))
            assertFalse(BrowserNavigationPolicy.canAdoptAuthenticationWindow(url, true, 90))
        }
    }

    @Test
    fun nestedPagesReturnToTheAuthenticationParentInsteadOfDestroyingIt() {
        for (url in listOf("https://www.chess.com/article/example", "https://www.chess.com/home")) {
            assertFalse(BrowserNavigationPolicy.canAdoptAuthenticationWindow(url, true, 100, hasParentWindow = true))
        }
    }

    @Test
    fun authenticationTabKeepsEmailLinksInternalAndRecognizesBlockedGoogleUrls() {
        for (url in listOf("https://www.chess.com/login", "https://www.chess.com/login/google", "https://accounts.google.com/o/oauth2/v2/auth?state=local", "https://www.chess.com/auth/email?token=example", "https://mail.example.com/secure-link")) {
            assertTrue(url, BrowserNavigationPolicy.isSupportedAuthenticationUrl(url))
        }
        assertTrue(BrowserNavigationPolicy.isAccountPage("https://www.chess.com/login/google"))
        assertTrue(BrowserNavigationPolicy.isAccountPage("https://www.chess.com/magic-link/consume"))
        assertTrue(BrowserNavigationPolicy.isAccountPage("https://www.chess.com/verify/email"))
        for (url in listOf("javascript:alert(1)", "file:///data/local", "intent://login", "http://www.chess.com/login", "https://user:password@www.chess.com/login", BrowserNavigationPolicy.CREDITS_URL)) {
            assertFalse(url, BrowserNavigationPolicy.isSupportedAuthenticationUrl(url))
        }
    }

    @Test
    fun androidEmailLinksOnlyEnterThroughTheRealChessComDomainFamily() {
        for (url in listOf("https://chess.com/login", "https://www.chess.com/login/email?token=secret", "https://link.chess.com/click?id=opaque", "https://links.chess.com/click?id=opaque", "https://click.chess.com/redirect")) {
            assertTrue(url, BrowserNavigationPolicy.isChessComFamilyUrl(url))
        }
        for (url in listOf("https://chess.com.attacker.test/login", "https://attackerchess.com/login", "https://user@www.chess.com/login", "http://link.chess.com/login", "javascript:location='https://chess.com'")) {
            assertFalse(url, BrowserNavigationPolicy.isChessComFamilyUrl(url))
        }
    }

    @Test
    fun sharedEmailTextExtractsOneSafeLinkWithoutExecutingOtherSchemes() {
        assertEquals("https://www.chess.com/login/email?token=opaque", BrowserNavigationPolicy.extractSupportedAuthenticationUrl("Войти: https://www.chess.com/login/email?token=opaque."))
        assertEquals("https://link.chess.com/click?id=opaque", BrowserNavigationPolicy.extractSupportedAuthenticationUrl("https://link.chess.com/click?id=opaque"))
        assertNull(BrowserNavigationPolicy.extractSupportedAuthenticationUrl("javascript:alert(1)"))
        assertNull(BrowserNavigationPolicy.extractSupportedAuthenticationUrl("только http://www.chess.com/login"))
        assertNull(BrowserNavigationPolicy.extractSupportedAuthenticationUrl("https://user:password@www.chess.com/login"))
    }

    @Test
    fun doesNotPromoteProviderPagesCallbacksOrdinaryLinksOrLookalikes() {
        for (url in listOf(BrowserNavigationPolicy.CHESS_COM_LOGIN, "https://www.chess.com/oauth/apple", "https://www.chess.com/callback/facebook", "https://www.chess.com/authorize", "https://accounts.google.com/", "https://appleid.apple.com/", "https://lichess.org/", "https://www.chess.com.attacker.test/home", "https://user@www.chess.com/home", "http://www.chess.com/home", BrowserNavigationPolicy.CREDITS_URL, "not a URL")) {
            assertFalse(url, BrowserNavigationPolicy.canAdoptAuthenticationWindow(url, true, 100))
        }
    }
}
