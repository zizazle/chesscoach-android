package com.chesscoach.app

import java.net.URI
import java.util.Locale

internal object BrowserNavigationPolicy {
    const val CHESS_COM_LOGIN = "https://www.chess.com/login"
    const val CREDITS_URL = "https://appassets.androidplatform.net/assets/pages/credits.html"

    enum class Destination { GAME, GOOGLE_AUTH, WEB, CREDITS, EXTERNAL_APP, BLOCKED }

    private val gameHosts = setOf("lichess.org", "www.chess.com", "chess.com")
    private val accountPath = Regex("^/(?:login|signin|signup|register|oauth|auth|password|reset-password|account/(?:login|signin|password|reset-password))(?:/|$)")
    private val googlePath = Regex("^/(?:login|register|signup|oauth|auth)(?:/[^/]+)*/google(?:/|$)")

    fun classify(url: String): Destination {
        if (url.isBlank() || url.length > 8192 || url.any { it.isISOControl() }) return Destination.BLOCKED
        val uri = try { URI(url) } catch (_: Exception) { return Destination.BLOCKED }
        val scheme = uri.scheme?.lowercase(Locale.ROOT)
        if (scheme == "mailto" || scheme == "tel") return Destination.EXTERNAL_APP
        if (scheme != "https" || uri.isOpaque || uri.rawUserInfo != null) return Destination.BLOCKED
        if (uri.port != -1 && uri.port != 443) return Destination.BLOCKED
        val host = uri.host?.lowercase(Locale.ROOT) ?: return Destination.BLOCKED
        val authority = uri.rawAuthority?.lowercase(Locale.ROOT)
        if (authority != host && authority != "$host:443") return Destination.BLOCKED
        if (host == "appassets.androidplatform.net") {
            return if (uri.rawPath == "/assets/pages/credits.html" && uri.rawQuery == null) {
                Destination.CREDITS
            } else Destination.BLOCKED
        }
        if (host == "accounts.google.com" || (host in gameHosts && googlePath.containsMatchIn(uri.path.orEmpty().lowercase(Locale.ROOT)))) {
            return Destination.GOOGLE_AUTH
        }
        return if (host in gameHosts) Destination.GAME else Destination.WEB
    }

    fun isAccountPage(url: String): Boolean = try {
        classify(url) == Destination.GAME && accountPath.containsMatchIn(URI(url).path.orEmpty().lowercase(Locale.ROOT))
    } catch (_: Exception) { false }
}
