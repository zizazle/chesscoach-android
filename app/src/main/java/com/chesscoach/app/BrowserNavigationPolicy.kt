package com.chesscoach.app

import java.net.URI
import java.util.Locale

internal object BrowserNavigationPolicy {
    const val CHESS_COM_LOGIN = "https://www.chess.com/login"
    const val CREDITS_URL = "https://appassets.androidplatform.net/assets/pages/credits.html"

    enum class Destination { GAME, GOOGLE_AUTH, WEB, CREDITS, EXTERNAL_APP, BLOCKED }

    private val gameHosts = setOf("lichess.org", "www.chess.com", "chess.com")
    private val accountPath = Regex("^/(?:login|signin|signup|register|oauth|auth|callback|authorize|verify|magic(?:-link)?|email(?:-login)?|sso|social|connect|password|reset-password|account/(?:login|signin|password|reset-password|verify))(?:/|$)")
    private val googlePath = Regex("^/(?:login|register|signup|oauth|auth)(?:/[^/]+)*/google(?:/|$)")
    private val sharedHttpsUrl = Regex("https://[^\\s<>\"']+", RegexOption.IGNORE_CASE)

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
        classify(url) in setOf(Destination.GAME, Destination.GOOGLE_AUTH) &&
            URI(url).host?.lowercase(Locale.ROOT) in gameHosts && accountPath.containsMatchIn(URI(url).path.orEmpty().lowercase(Locale.ROOT))
    } catch (_: Exception) { false }

    fun isSupportedAuthenticationUrl(url: String): Boolean =
        classify(url) in setOf(Destination.GAME, Destination.WEB, Destination.GOOGLE_AUTH)

    fun extractSupportedAuthenticationUrl(text: String): String? {
        if (text.isBlank() || text.length > 16_384 || text.any { it.isISOControl() && !it.isWhitespace() }) return null
        val direct = text.trim()
        if (isSupportedAuthenticationUrl(direct)) return direct
        return sharedHttpsUrl.findAll(text).map { it.value.trimEnd('.', ',', ';', ')', ']', '}') }
            .firstOrNull(::isSupportedAuthenticationUrl)
    }

    fun isChessComFamilyUrl(url: String): Boolean {
        if (!isSupportedAuthenticationUrl(url)) return false
        return try {
            val host = URI(url).host?.lowercase(Locale.ROOT) ?: return false
            host == "chess.com" || host.endsWith(".chess.com")
        } catch (_: Exception) { false }
    }

    fun canAdoptAuthenticationWindow(url: String, authenticationWindow: Boolean, progress: Int, hasParentWindow: Boolean = false): Boolean =
        authenticationWindow && !hasParentWindow && progress == 100 && classify(url) == Destination.GAME &&
            URI(url).host?.lowercase(Locale.ROOT) in setOf("www.chess.com", "chess.com") && !isAccountPage(url)
}
