package com.chesscoach.app

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.os.PowerManager
import android.os.SystemClock
import android.text.InputType
import android.view.InputDevice
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AlertDialog
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
import androidx.core.graphics.toColorInt
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.nio.charset.StandardCharsets
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future

class MainActivity : AppCompatActivity() {
    private lateinit var rootLayout: FrameLayout
    private lateinit var browserContainer: FrameLayout
    private lateinit var browserAddress: TextView
    private lateinit var browserProgress: ProgressBar
    private lateinit var browserForward: Button
    private lateinit var browserReload: Button
    private lateinit var mainWebView: WebView
    private lateinit var engineWebView: WebView
    private lateinit var storageRepository: AtomicStorageRepository
    private lateinit var capabilityProfiler: DeviceCapabilityProfiler

    private val mainHandler = Handler(Looper.getMainLooper())
    private val storageExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val bundleExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val bundleCache = ConcurrentHashMap<Platform, String>()
    private val clientInstanceId = UUID.randomUUID().toString()
    private val pendingRuntime = LinkedHashMap<String, PendingRuntimeRequest>()
    private val pendingAsync = LinkedHashMap<String, PendingAsyncRequest>()
    private val overallLimiter = SlidingWindowLimiter(100, 10_000L)
    private val runtimeLimiter = SlidingWindowLimiter(50, 5_000L)
    private val storageLimiter = SlidingWindowLimiter(30, 10_000L)
    private val profileLimiter = SlidingWindowLimiter(10, 60_000L)
    private val platformLimiter = SlidingWindowLimiter(4, 60_000L)
    private val engineLimiter = SlidingWindowLimiter(100, 5_000L)
    private var dispatchingNativeTouch = false
    private val nativeInput = NativeInputController(object : NativeInputController.Host {
        override fun now(): Long = SystemClock.uptimeMillis()
        override fun rateNow(): Long = SystemClock.elapsedRealtime()
        override fun state(view: Any): NativeInputController.ViewState {
            val browser = view as WebView
            return NativeInputController.ViewState(
                pageGeneration, browser === mainWebView, isResumedState, isDestroyedState,
                inputNavigationPending, popupWebView != null, browser.isAttachedToWindow,
                browser.isShown && browser.windowVisibility == View.VISIBLE, browser.hasWindowFocus(),
                browser.width, browser.height, browser.paddingLeft, browser.paddingTop, browser.paddingRight,
                browser.paddingBottom, if (browser === mainWebView) browser.url.orEmpty() else ""
            )
        }
        override fun inspect(view: Any, script: String, callback: (String?) -> Unit) {
            (view as WebView).evaluateJavascript(script) { callback(it) }
        }
        override fun dispatch(view: Any, action: Int, point: BridgeProtocol.TouchPoint, downTime: Long): Boolean =
            dispatchNativeTouch(view as WebView, action, point, downTime)
        override fun schedule(runnable: Runnable, at: Long) { mainHandler.postAtTime(runnable, at) }
        override fun remove(runnable: Runnable) { mainHandler.removeCallbacks(runnable) }
    })
    private val browserPopups = mutableListOf<WebView>()
    private val authenticationWindows = mutableSetOf<WebView>()
    private val popupWebView: WebView? get() = browserPopups.lastOrNull()
    private var pendingMainReload = false
    private var googleSignInDialog: AlertDialog? = null
    private var loadErrorDialog: AlertDialog? = null

    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .setDomain(APP_ASSET_HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/__cc_assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    private var documentStartHandler: ScriptHandler? = null
    private var privacyStartHandler: ScriptHandler? = null
    private var pageGeneration = 0L
    private var inputNavigationPending = false
    private var storageRevision = 0L
    private var engineDocumentLoaded = false
    private var isResumedState = false
    private var isDestroyedState = false
    private var mainRendererRecoveries = 0
    private var engineRendererRecoveries = 0
    private var enginePermanentlyUnavailable = false
    private var appLifecycleGeneration = 0L
    private var engineNeedsReload = false
    private var powerReceiverRegistered = false
    private var removeThermalListener: (() -> Unit)? = null
    private val powerSaveReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == PowerManager.ACTION_POWER_SAVE_MODE_CHANGED) {
                publishCurrentDeviceProfile()
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        WindowCompat.setDecorFitsSystemWindows(window, false)

        storageRepository = AtomicStorageRepository(applicationContext)
        capabilityProfiler = DeviceCapabilityProfiler(applicationContext)

        rootLayout = FrameLayout(this).apply {
            setBackgroundColor("#06080E".toColorInt())
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }
        setContentView(rootLayout)

        engineWebView = createEngineWebView().also { rootLayout.addView(it, 0) }
        createBrowserChrome()
        mainWebView = createMainWebView().also { browserContainer.addView(it) }
        ViewCompat.setOnApplyWindowInsetsListener(rootLayout) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            insets
        }
        ViewCompat.requestApplyInsets(rootLayout)
        setupBackNavigation()
        registerDeviceStateListeners()

        engineWebView.loadUrl(ENGINE_URL)
        if (!restoreTrustedState(savedInstanceState)) {
            mainWebView.loadUrl(lastPlatform().url)
        }
        mainHandler.post { handleIncomingAuthenticationIntent(intent) }

        if (!bridgeFeaturesAvailable()) {
            Toast.makeText(
                this,
                "Обновите Android System WebView для функций ChessCoach",
                Toast.LENGTH_LONG
            ).show()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingAuthenticationIntent(intent)
    }

    private fun handleIncomingAuthenticationIntent(intent: Intent?) {
        val url = when (intent?.action) {
            Intent.ACTION_VIEW -> intent.data?.toString()?.takeIf(BrowserNavigationPolicy::isChessComFamilyUrl)
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)?.let(BrowserNavigationPolicy::extractSupportedAuthenticationUrl)
            else -> null
        }
        if (url == null) {
            if (intent?.action == Intent.ACTION_VIEW || intent?.action == Intent.ACTION_SEND) {
                Toast.makeText(this, "Нужна безопасная HTTPS-ссылка входа", Toast.LENGTH_LONG).show()
            }
            return
        }
        openAuthenticationTab(Uri.parse(url))
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createMainWebView(): WebView {
        val view = WebView(this).apply {
            setBackgroundColor("#06080E".toColorInt())
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }
        configureMainBrowser(view)
        return view
    }

    private fun configureMainBrowser(view: WebView) {
        configureSecureSettings(view, browsing = true)
        // A site's target=_blank login must stay in the app's primary browsing context.
        view.settings.setSupportMultipleWindows(false)
        // Native board gestures rely on an unzoomed CSS viewport.
        view.settings.setSupportZoom(false)
        view.settings.builtInZoomControls = false
        registerRemoteBridge(view)
        installDocumentStartScripts(view)
        view.webViewClient = createMainWebViewClient()
        view.webChromeClient = createBrowserWebChromeClient()
        view.setOnTouchListener { _, event ->
            if (!dispatchingNativeTouch && event.actionMasked == MotionEvent.ACTION_DOWN) {
                cancelPendingTouch("USER_INPUT", "A user touch cancelled the native gesture")
            }
            false
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createEngineWebView(): WebView {
        val view = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            alpha = 0f
            isFocusable = false
            isFocusableInTouchMode = false
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            layoutParams = FrameLayout.LayoutParams(1, 1)
        }
        configureSecureSettings(view)
        registerEngineBridge(view)
        view.webViewClient = createEngineWebViewClient()
        return view
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureSecureSettings(view: WebView, browsing: Boolean = false) {
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            safeBrowsingEnabled = true
            mediaPlaybackRequiresUserGesture = true
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(browsing)
            setSupportZoom(browsing)
            builtInZoomControls = browsing
            displayZoomControls = false
            useWideViewPort = browsing
            loadWithOverviewMode = browsing
            cacheMode = WebSettings.LOAD_DEFAULT
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(view, browsing)
        }
    }

    private fun createMainWebViewClient(): WebViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            return routeBrowserNavigation(view, request.url, request.hasGesture())
        }

        @Deprecated("Deprecated in Android")
        override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
            return routeBrowserNavigation(view, Uri.parse(url), userGesture = false)
        }

        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest
        ): WebResourceResponse? {
            return interceptRemotePackagedAsset(request) ?: super.shouldInterceptRequest(view, request)
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            pageGeneration++
            inputNavigationPending = true
            nativeInput.invalidateDocument("INPUT_DOCUMENT_CHANGED", "The game document is navigating")
            cancelRemoteWork("NAVIGATION_CANCELLED", "Document navigation cancelled the request")
            loadErrorDialog?.dismiss()
            val uri = Uri.parse(url)
            if (BrowserNavigationPolicy.classify(url) != BrowserNavigationPolicy.Destination.GAME) {
                view.stopLoading()
                routeBrowserNavigation(view, uri, userGesture = false)
                return
            }
            updateBrowserChrome(view, url)
            super.onPageStarted(view, url, favicon)
        }

        override fun onPageCommitVisible(view: WebView, url: String) {
            if (view === mainWebView) inputNavigationPending = false
            if (BrowserNavigationPolicy.classify(url) != BrowserNavigationPolicy.Destination.GAME) {
                view.stopLoading()
                return
            }
            super.onPageCommitVisible(view, url)
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (view === mainWebView) inputNavigationPending = false
            super.onPageFinished(view, url)
            CookieManager.getInstance().flush()
            updateBrowserChrome(view, url)
            if (!isTrustedRemoteUri(Uri.parse(url)) || BrowserNavigationPolicy.isAccountPage(url)) return
            injectMainBundle(view, url, pageGeneration, 0)
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            super.doUpdateVisitedHistory(view, url, isReload)
            updateBrowserChrome(view, url.orEmpty())
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) showBrowserError(view, "Не удалось загрузить страницу. Проверьте подключение и обновите Android System WebView.")
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame && response.statusCode >= 500) showBrowserError(view, "Сайт временно недоступен (HTTP ${response.statusCode}).")
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (!::mainWebView.isInitialized || view !== mainWebView) return true
            recoverMainRenderer(detail.didCrash())
            return true
        }
    }

    private fun createBrowserChrome() {
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = FrameLayout.LayoutParams(-1, -1)
        }
        val toolbar = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor("#101A25".toColorInt())
            layoutParams = LinearLayout.LayoutParams(-1, dp(48))
        }
        toolbar.addView(browserButton("\u2039", "Назад") { handleBrowserBack() })
        browserForward = browserButton("\u203a", "Вперёд") {
            val view = activeBrowser()
            flushPreferencesBeforeNavigation(view) { view.goForward() }
        }
        toolbar.addView(browserForward)
        browserAddress = TextView(this).apply {
            setTextColor("#C9D8E4".toColorInt())
            textSize = 11f
            maxLines = 2
            ellipsize = android.text.TextUtils.TruncateAt.END
            setPadding(dp(6), 0, dp(6), 0)
            text = "ChessCoach FREE"
            contentDescription = "Адрес открытого сайта"
            setOnClickListener {
                val uri = Uri.parse(activeBrowser().url.orEmpty())
                AlertDialog.Builder(this@MainActivity)
                    .setTitle("Открытый сайт")
                    .setMessage(if (uri.scheme == "https") "https://${uri.encodedAuthority}" else "Страница ещё не загружена")
                    .setPositiveButton("Закрыть", null).show()
            }
        }
        toolbar.addView(browserAddress, LinearLayout.LayoutParams(0, -2, 1f))
        browserReload = browserButton("\u21bb", "Обновить страницу") {
            val view = activeBrowser()
            if (view.progress < 100) view.stopLoading() else flushPreferencesBeforeNavigation(view) { view.reload() }
        }
        toolbar.addView(browserReload)
        val menuButton = browserButton("...", "Меню браузера") {}
        menuButton.setOnClickListener { showBrowserMenu(menuButton) }
        toolbar.addView(menuButton)
        column.addView(toolbar)
        browserProgress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progressTintList = android.content.res.ColorStateList.valueOf("#62DFC2".toColorInt())
            visibility = View.INVISIBLE
        }
        column.addView(browserProgress, LinearLayout.LayoutParams(-1, dp(2)))
        browserContainer = FrameLayout(this)
        column.addView(browserContainer, LinearLayout.LayoutParams(-1, 0, 1f))
        rootLayout.addView(column)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun browserButton(label: String, description: String, action: () -> Unit): Button = Button(this).apply {
        text = label
        contentDescription = description
        textSize = 23f
        typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        setTextColor("#82ECD1".toColorInt())
        setBackgroundColor(Color.TRANSPARENT)
        minWidth = 0
        minimumWidth = 0
        setPadding(0, 0, 0, 0)
        layoutParams = LinearLayout.LayoutParams(dp(44), dp(48))
        setOnClickListener { action() }
    }

    private fun activeBrowser(): WebView = popupWebView ?: mainWebView

    private fun updateBrowserChrome(view: WebView, url: String = view.url.orEmpty()) {
        if (isDestroyedState || view !== activeBrowser()) return
        val host = if (BrowserNavigationPolicy.classify(url) == BrowserNavigationPolicy.Destination.CREDITS) "О проекте" else Uri.parse(url).host.orEmpty()
        browserAddress.text = "ChessCoach FREE\n$host"
        browserForward.isEnabled = view.canGoForward()
        browserReload.text = if (view.progress < 100) "\u00d7" else "\u21bb"
        browserReload.contentDescription = if (view.progress < 100) "Остановить загрузку" else "Обновить страницу"
        browserProgress.progress = view.progress
        browserProgress.visibility = if (view.progress < 100) View.VISIBLE else View.INVISIBLE
    }

    private fun showBrowserMenu(anchor: View) {
        val menu = PopupMenu(this, anchor)
        menu.menu.add(0, 1, 0, "Вход Chess.com во внутренней вкладке")
        menu.menu.add(0, 2, 1, "Открыть Chess.com")
        menu.menu.add(0, 3, 2, "Открыть Lichess")
        menu.menu.add(0, 4, 3, "О проекте и благодарности")
        menu.menu.add(0, 6, 5, "Диагностика")
        menu.menu.add(0, 7, 6, "Открыть ссылку входа")
        popupWebView?.let { popup ->
            menu.menu.add(0, 5, 4, if (canAdoptAuthenticationWindow(popup)) "Вернуться к ChessCoach" else "Закрыть вкладку")
        }
        menu.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                1 -> openAuthenticationTab(Uri.parse(BrowserNavigationPolicy.CHESS_COM_LOGIN))
                2 -> openGamePage(Platform.CHESS_COM.url)
                3 -> openGamePage(Platform.LICHESS.url)
                4 -> openBrowserPopup(Uri.parse(BrowserNavigationPolicy.CREDITS_URL))
                5 -> closeBrowserPopup()
                6 -> showInputDiagnostics()
                7 -> showAuthenticationLinkDialog()
            }
            true
        }
        menu.show()
    }

    private fun showInputDiagnostics() {
        val version = packageManager.getPackageInfo(packageName, 0).versionName.orEmpty()
        val details = TextView(this).apply {
            setTextIsSelectable(true)
            setPadding(dp(16), dp(12), dp(16), dp(12))
            textSize = 12f
            text = "$packageName $version\n\n${nativeInput.diagnostics()}"
        }
        val scroll = ScrollView(this).apply { addView(details) }
        AlertDialog.Builder(this).setTitle("Диагностика приложения").setView(scroll)
            .setPositiveButton("Закрыть", null).show()
        val view = mainWebView
        if (!isTrustedRemoteUri(Uri.parse(view.url.orEmpty()))) return
        val script = """
            (function(){try{
              var g=window.__CC_ANDROID_GAME_SESSION__,p=window.__CC_MOBILE_PREFERENCES__;
              var s=g?g.snapshot():{},platform=s.platform||(/chess\.com$/.test(location.hostname)?'chesscom':'lichess');
              var requested=p&&p.isReady?p.get(platform):{},effective=g?g.effective():{};
              return JSON.stringify({coreReady:!!s.ready,preferencesReady:!!(p&&p.isReady),
                paused:!!s.paused,foreground:!!s.foreground,lowTier:!!s.lowTier,
                positionId:s.positionId,boardId:s.boardId,turn:s.turn,myColor:s.myColor,
                analysis:s.analysis,pendingInput:!!s.pendingInput,
                requested:{auto:!!requested.autoMoveEnabled,turbo:!!requested.bulletTurboMode,
                  premove:!!requested.premoveEnabled,ratedBlock:!!requested.safeAntiBanGuard},
                effective:{auto:!!effective.autoMoveEnabled,turbo:!!effective.bulletTurboMode,
                  premove:!!effective.premoveEnabled,thermalPause:!!effective.thermalPause}});
            }catch(e){return JSON.stringify({coreDiagnostics:'unavailable'});}})();
        """.trimIndent()
        view.evaluateJavascript(script) { result ->
            if (isDestroyedState || view !== mainWebView) return@evaluateJavascript
            val summary = try { JSONArray("[$result]").optString(0, "Недоступно") } catch (_: Exception) { "Недоступно" }
            details.append("\n\nСостояние игры и настроек:\n$summary")
        }
    }

    private fun flushPreferencesBeforeNavigation(view: WebView, action: () -> Unit) {
        if (isDestroyedState) return
        val generation = pageGeneration
        val token = quoteForJavaScript(UUID.randomUUID().toString())
        val deadline = SystemClock.uptimeMillis() + 5_000L
        fun isCurrent(): Boolean = !isDestroyedState &&
            (view === mainWebView || view in browserPopups) && generation == pageGeneration
        fun inspect() {
            if (!isCurrent()) return
            view.evaluateJavascript("(function(){var s=window.__CC_ANDROID_NAV_FLUSH__;return s&&s.token===$token?s.status:'superseded';})();") { result ->
                if (!isCurrent()) return@evaluateJavascript
                when (result) {
                    "\"ready\"" -> action()
                    "\"failed\"" -> Toast.makeText(this, "Не удалось сохранить настройки. Переход отменён.", Toast.LENGTH_LONG).show()
                    "\"superseded\"" -> Unit
                    else -> if (SystemClock.uptimeMillis() < deadline) mainHandler.postDelayed({ inspect() }, 40L)
                    else Toast.makeText(this, "Настройки ещё сохраняются. Повторите переход.", Toast.LENGTH_LONG).show()
                }
            }
        }
        val script = """
            (function(){
              var r=window.__CC_ANDROID_RUNTIME__;
              if(!r||typeof r.flushStorage!=='function')return 'ready';
              var token=$token;
              window.__CC_ANDROID_NAV_FLUSH__={token:token,status:'pending'};
              Promise.resolve().then(function(){return r.flushStorage();}).then(function(){
                var s=window.__CC_ANDROID_NAV_FLUSH__;if(s&&s.token===token)s.status='ready';
              },function(){
                var s=window.__CC_ANDROID_NAV_FLUSH__;if(s&&s.token===token)s.status='failed';
              });
              return 'pending';
            })();
        """.trimIndent()
        view.evaluateJavascript(script) { result ->
            if (!isCurrent()) return@evaluateJavascript
            if (result == "\"ready\"") action() else inspect()
        }
    }

    private fun openGamePage(url: String, reloadCurrentDocument: Boolean = false) {
        flushPreferencesBeforeNavigation(mainWebView) { navigateGamePage(url, reloadCurrentDocument) }
    }

    private fun navigateGamePage(url: String, reloadCurrentDocument: Boolean = false) {
        val popup = popupWebView
        if (popup != null && canAdoptAuthenticationWindow(popup) && platformForUri(Uri.parse(url)) == Platform.CHESS_COM && !BrowserNavigationPolicy.isAccountPage(url)) {
            adoptAuthenticationWindow(popup, url)
            return
        }
        closeAllBrowserPopups(restoreMain = false)
        pendingMainReload = false
        val platform = platformForUri(Uri.parse(url)) ?: return
        val targetView = mainWebView
        storageExecutor.execute {
            val saved = try {
                storageRepository.set(JSONObject().put(PLATFORM_STORAGE_KEY, platform.storageValue))
                true
            } catch (_: Exception) { false }
            mainHandler.post {
                if (isDestroyedState || mainWebView !== targetView) return@post
                if (saved) storageRevision++
                installDocumentStartScripts(targetView)
                if (isResumedState) targetView.onResume()
                if (reloadCurrentDocument && targetView.url?.substringBefore('#') == url.substringBefore('#')) {
                    if (targetView.url != url) targetView.loadUrl(url)
                    targetView.reload()
                } else {
                    targetView.loadUrl(url)
                }
                if (!saved) Toast.makeText(this, "Не удалось сохранить выбор площадки. Страница всё равно открыта.", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun routeBrowserNavigation(view: WebView, uri: Uri, userGesture: Boolean): Boolean {
        return when (BrowserNavigationPolicy.classify(uri.toString())) {
            BrowserNavigationPolicy.Destination.GAME -> {
                if (view === mainWebView && uri.host.equals("www.chess.com", ignoreCase = true) && BrowserNavigationPolicy.isAccountPage(uri.toString())) {
                    openAuthenticationTab(uri)
                    true
                } else false
            }
            BrowserNavigationPolicy.Destination.GOOGLE_AUTH -> {
                if (view in browserPopups) authenticationWindows.add(view)
                view.stopLoading()
                showGoogleSignInUnavailable()
                true
            }
            BrowserNavigationPolicy.Destination.WEB -> {
                if (view === popupWebView) false else {
                    openBrowserPopup(uri)
                    true
                }
            }
            BrowserNavigationPolicy.Destination.CREDITS -> {
                if (view === popupWebView) false else {
                    openBrowserPopup(uri)
                    true
                }
            }
            BrowserNavigationPolicy.Destination.EXTERNAL_APP -> {
                if (userGesture) openExternal(uri)
                true
            }
            BrowserNavigationPolicy.Destination.BLOCKED -> {
                Toast.makeText(this, "Небезопасный или неподдерживаемый адрес заблокирован", Toast.LENGTH_SHORT).show()
                true
            }
        }
    }

    private fun openAuthenticationTab(uri: Uri) {
        if (isDestroyedState || !BrowserNavigationPolicy.isSupportedAuthenticationUrl(uri.toString())) return
        val current = popupWebView
        if (current != null && current in authenticationWindows) {
            if (current.url != uri.toString()) current.loadUrl(uri.toString())
            current.visibility = View.VISIBLE
            updateBrowserChrome(current, uri.toString())
            return
        }
        flushPreferencesBeforeNavigation(mainWebView) {
            if (browserPopups.size >= 3) {
                Toast.makeText(this, "Сначала закройте одну из открытых вкладок", Toast.LENGTH_SHORT).show()
            } else {
                createBrowserPopup(authentication = true).loadUrl(uri.toString())
            }
        }
    }

    private fun showGoogleSignInUnavailable() {
        if (isDestroyedState || googleSignInDialog?.isShowing == true) return
        val dialog = AlertDialog.Builder(this)
            .setTitle("Google-вход недоступен во WebView")
            .setMessage("Google запрещает OAuth-вход во встроенных браузерах, которыми управляет приложение. Поэтому Chess.com показывает общую ошибку \"There was an issue logging in with Google\". Это не исправляется cookies или настройками WebView.\n\nИспользуйте быструю ссылку из письма в том же профиле: Поделиться → ChessCoach или вставьте ссылку вручную. Также доступна обычная форма Chess.com. Проверку Cloudflare на форме нужно пройти.")
            .setPositiveButton("Вставить ссылку") { _, _ -> mainHandler.post { if (!isDestroyedState) showAuthenticationLinkDialog() } }
            .setNeutralButton("Форма Chess.com") { _, _ -> mainHandler.post { if (!isDestroyedState) openAuthenticationTab(Uri.parse(BrowserNavigationPolicy.CHESS_COM_LOGIN)) } }
            .setNegativeButton("Закрыть", null)
            .create()
        dialog.setOnDismissListener { if (googleSignInDialog === dialog) googleSignInDialog = null }
        googleSignInDialog = dialog
        dialog.show()
    }

    private fun showAuthenticationLinkDialog() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            hint = "https://..."
            maxLines = 3
        }
        AlertDialog.Builder(this).setTitle("Ссылка входа в приложении")
            .setMessage("Можно вставить ссылку из письма и открыть её в том же браузерном профиле. Ссылка не сохраняется в настройках или диагностике.")
            .setView(input)
            .setPositiveButton("Открыть") { _, _ ->
                val url = BrowserNavigationPolicy.extractSupportedAuthenticationUrl(input.text.toString())
                if (url != null) openAuthenticationTab(Uri.parse(url))
                else Toast.makeText(this, "Для вкладки входа нужен безопасный HTTPS-адрес", Toast.LENGTH_LONG).show()
            }
            .setNegativeButton("Отмена", null).show()
    }

    private fun createBrowserWebChromeClient(): WebChromeClient = object : WebChromeClient() {
        override fun onProgressChanged(view: WebView, newProgress: Int) {
            updateBrowserChrome(view)
        }

        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            if (!isUserGesture || isDestroyedState) return false
            if (browserPopups.size >= 3) {
                Toast.makeText(this@MainActivity, "Сначала закройте одну из открытых вкладок", Toast.LENGTH_SHORT).show()
                return false
            }
            val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
            val popup = createBrowserPopup()
            transport.webView = popup
            resultMsg.sendToTarget()
            return true
        }

        override fun onCloseWindow(window: WebView) {
            if (window === popupWebView) closeBrowserPopup()
            else if (browserPopups.remove(window)) {
                pendingMainReload = authenticationWindows.remove(window) || pendingMainReload
                detachAndDestroyWebView(window, REMOTE_BRIDGE_NAME)
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createBrowserPopup(authentication: Boolean = false): WebView {
        val parent = activeBrowser()
        val inheritsAuthFlow = parent in authenticationWindows || BrowserNavigationPolicy.isAccountPage(parent.url.orEmpty())
        cancelRemoteWork("BROWSER_OPEN", "A browser window paused game interaction")
        mainWebView.evaluateJavascript("window.dispatchEvent(new CustomEvent('cc-mobile-lifecycle',{detail:{state:'settings',cancelPendingMoves:true}}));", null)
        parent.onPause()
        if (parent !== mainWebView) parent.visibility = View.GONE
        val popup = WebView(this).apply {
            setBackgroundColor("#06080E".toColorInt())
            layoutParams = FrameLayout.LayoutParams(-1, -1)
        }
        // Browsing/authentication windows share WebView cookies, never the engine/native bridge.
        configureSecureSettings(popup, browsing = true)
        browserPopups.add(popup)
        if (authentication || inheritsAuthFlow) authenticationWindows.add(popup)
        popup.webChromeClient = createBrowserWebChromeClient()
        popup.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                return routeBrowserNavigation(view, request.url, request.hasGesture())
            }

            @Deprecated("Deprecated in Android")
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
                routeBrowserNavigation(view, Uri.parse(url), userGesture = false)

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                if (isAppAssetUri(request.url)) assetLoader.shouldInterceptRequest(request.url) else null

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                if (url == "about:blank") return
                loadErrorDialog?.dismiss()
                if (BrowserNavigationPolicy.isAccountPage(url)) authenticationWindows.add(view)
                val destination = BrowserNavigationPolicy.classify(url)
                if (destination == BrowserNavigationPolicy.Destination.GOOGLE_AUTH) {
                    authenticationWindows.add(view)
                    view.stopLoading()
                    showGoogleSignInUnavailable()
                    return
                }
                if (destination == BrowserNavigationPolicy.Destination.BLOCKED || destination == BrowserNavigationPolicy.Destination.EXTERNAL_APP) {
                    view.stopLoading()
                    routeBrowserNavigation(view, Uri.parse(url), userGesture = false)
                    return
                }
                updateBrowserChrome(view, url)
            }

            override fun onPageFinished(view: WebView, url: String) {
                CookieManager.getInstance().flush()
                updateBrowserChrome(view, url)
            }

            override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
                super.doUpdateVisitedHistory(view, url, isReload)
                updateBrowserChrome(view, url.orEmpty())
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showBrowserError(view, "Не удалось загрузить страницу. Проверьте соединение; небезопасные соединения не разрешены.")
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame && request.url.host == "accounts.google.com" && response.statusCode in setOf(400, 403)) {
                    showBrowserError(view, "Сервис Google отклонил вход из Android WebView (HTTP ${response.statusCode}). Мы не подменяем браузер и не переносим сессию из Chrome. Другой поддерживаемый способ входа можно выбрать в этой же вкладке.")
                }
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (view in browserPopups) closeAllBrowserPopups()
                return true
            }
        }
        browserContainer.addView(popup)
        updateBrowserChrome(popup)
        return popup
    }

    private fun openBrowserPopup(uri: Uri) {
        if (popupWebView?.url == uri.toString()) return
        if (browserPopups.size >= 3) {
            Toast.makeText(this, "Сначала закройте одну из открытых вкладок", Toast.LENGTH_SHORT).show()
            return
        }
        createBrowserPopup().loadUrl(uri.toString())
    }

    private fun closeBrowserPopup(restoreMain: Boolean = true) {
        val popup = popupWebView ?: return
        if (restoreMain && canAdoptAuthenticationWindow(popup)) {
            adoptAuthenticationWindow(popup, popup.url.orEmpty())
            return
        }
        browserPopups.remove(popup)
        pendingMainReload = authenticationWindows.remove(popup) || pendingMainReload
        loadErrorDialog?.dismiss()
        detachAndDestroyWebView(popup, REMOTE_BRIDGE_NAME)
        CookieManager.getInstance().flush()
        if (isDestroyedState || !restoreMain) return
        val parent = popupWebView
        if (parent != null) {
            parent.visibility = View.VISIBLE
            if (isResumedState) parent.onResume()
            updateBrowserChrome(parent)
        } else {
            resumeMainBrowser()
        }
    }

    private fun canAdoptAuthenticationWindow(view: WebView): Boolean =
        BrowserNavigationPolicy.canAdoptAuthenticationWindow(view.url.orEmpty(), view in authenticationWindows, view.progress, browserPopups.size > 1)

    private fun adoptAuthenticationWindow(view: WebView, url: String) {
        flushPreferencesBeforeNavigation(mainWebView) { activateAuthenticationWindow(view, url) }
    }

    private fun activateAuthenticationWindow(view: WebView, url: String) {
        if (isDestroyedState || view !== popupWebView || !canAdoptAuthenticationWindow(view)) return
        cancelRemoteWork("AUTH_WINDOW_RETURN", "The signed-in browser window became the main window")
        browserPopups.remove(view)
        authenticationWindows.remove(view)
        closeAllBrowserPopups(restoreMain = false)
        val previousMain = mainWebView
        mainWebView = view
        pageGeneration++
        view.visibility = View.VISIBLE
        configureMainBrowser(view)
        detachAndDestroyWebView(previousMain, REMOTE_BRIDGE_NAME)
        // Reload the same WebView: its cookies and sessionStorage stay with the authenticated tab.
        navigateGamePage(url, reloadCurrentDocument = true)
    }

    private fun closeAllBrowserPopups(restoreMain: Boolean = true) {
        while (popupWebView != null) closeBrowserPopup(restoreMain = false)
        if (restoreMain) resumeMainBrowser()
    }

    private fun resumeMainBrowser() {
        if (isDestroyedState || !isResumedState || popupWebView != null) return
        mainWebView.onResume()
        mainWebView.evaluateJavascript("window.dispatchEvent(new CustomEvent('cc-mobile-lifecycle',{detail:{state:window.__CC_ANDROID_SETTINGS_OPEN__?'settings':'active',cancelPendingMoves:true}}));", null)
        if (pendingMainReload) {
            pendingMainReload = false
            mainWebView.reload()
        }
        updateBrowserChrome(mainWebView)
    }

    private fun showBrowserError(view: WebView, message: String) {
        if (isDestroyedState || view !== activeBrowser() || loadErrorDialog?.isShowing == true) return
        browserProgress.visibility = View.INVISIBLE
        loadErrorDialog = AlertDialog.Builder(this).setTitle("Страница не загрузилась").setMessage(message)
            .setPositiveButton("Повторить") { _, _ -> if (!isDestroyedState && view === activeBrowser()) view.reload() }
            .setNegativeButton("Закрыть", null).create().also { it.show() }
    }

    private fun createEngineWebViewClient(): WebViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            return request.url.toString() != ENGINE_URL
        }

        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest
        ): WebResourceResponse? {
            if (isAppAssetUri(request.url)) {
                return assetLoader.shouldInterceptRequest(request.url)
                    ?: super.shouldInterceptRequest(view, request)
            }
            if (!request.isForMainFrame && isAllowedEngineNetworkUri(request.url)) return null
            return forbiddenResponse()
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            engineDocumentLoaded = false
            cancelRuntimeRequests("ENGINE_RELOADING", "Engine document is reloading")
            if (url != ENGINE_URL) view.stopLoading()
            super.onPageStarted(view, url, favicon)
        }

        override fun onPageFinished(view: WebView, url: String) {
            super.onPageFinished(view, url)
            if (url != ENGINE_URL) return
            engineDocumentLoaded = true
            flushQueuedRuntimeRequests()
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (!::engineWebView.isInitialized || view !== engineWebView) return false
            recoverEngineRenderer(detail.didCrash())
            return true
        }
    }

    private fun registerRemoteBridge(view: WebView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        WebViewCompat.addWebMessageListener(view, REMOTE_BRIDGE_NAME, REMOTE_ORIGINS) {
                sourceView, message, sourceOrigin, isMainFrame, replyProxy ->
            runOnMain {
                handleRemoteMessage(
                    sourceView,
                    message.data,
                    sourceOrigin,
                    isMainFrame,
                    replyProxy
                )
            }
        }
    }

    private fun registerEngineBridge(view: WebView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        WebViewCompat.addWebMessageListener(view, ENGINE_BRIDGE_NAME, setOf(APP_ASSET_ORIGIN)) {
                sourceView, message, sourceOrigin, isMainFrame, replyProxy ->
            runOnMain {
                handleEngineMessage(
                    sourceView,
                    message.data,
                    sourceOrigin,
                    isMainFrame,
                    replyProxy
                )
            }
        }
    }

    private fun handleRemoteMessage(
        sourceView: WebView,
        raw: String?,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy
    ) {
        if (
            isDestroyedState || sourceView !== mainWebView || !isMainFrame ||
            trustedOrigin(sourceOrigin) == null ||
            trustedOrigin(sourceOrigin) != trustedOrigin(Uri.parse(sourceView.url.orEmpty()))
        ) {
            postError(replyProxy, safeMessageId(raw), "UNTRUSTED_SOURCE", "Untrusted message source")
            return
        }
        if (raw == null) {
            postError(replyProxy, "invalid", "INVALID_MESSAGE", "String message required")
            return
        }
        if (!overallLimiter.tryAcquire()) {
            postError(replyProxy, safeMessageId(raw), "RATE_LIMITED", "Message rate exceeded")
            return
        }

        val message = try {
            BridgeProtocol.parse(raw)
        } catch (error: Exception) {
            postError(replyProxy, safeMessageId(raw), "INVALID_MESSAGE", error.message ?: "Invalid message")
            return
        }

        try {
            enforceRemoteMessageSize(message, raw)
            validateRemoteMetadata(message)
            if (!isResumedState && !message.type.startsWith("input.")) {
                postError(replyProxy, message.id, "APP_PAUSED", "The app is paused")
                return
            }
            when (message.type) {
                "runtime.message" -> handleRuntimeRequest(message, replyProxy, sourceOrigin)
                "storage.get" -> handleStorageGet(message, replyProxy)
                "storage.patch" -> handleStoragePatch(message, replyProxy)
                "storage.set" -> handleStorageSet(message, replyProxy)
                "storage.replace" -> handleStorageReplace(message, replyProxy)
                "storage.remove" -> handleStorageRemove(message, replyProxy)
                "storage.clear" -> handleStorageClear(message, replyProxy)
                "device.profile.get" -> handleDeviceProfileRequest(message, replyProxy, full = false)
                "platform.switch" -> handlePlatformSwitch(message, replyProxy)
                "project.open" -> {
                    BridgeProtocol.requireOnlyKeys(message.payload, emptySet())
                    require(nativeInput.tryBrowserAction()) { "Browser action rate exceeded" }
                    postReply(replyProxy, BridgeProtocol.response(message.id, "project.open.response", "project", JSONObject().put("ok", true)))
                    mainHandler.post { if (!isDestroyedState) openBrowserPopup(Uri.parse(BrowserNavigationPolicy.CREDITS_URL)) }
                }
                "input.context.get", "input.gesture", "input.cancel" ->
                    nativeInput.handle(message, sourceView, trustedOrigin(sourceOrigin)!!) { postReply(replyProxy, it) }
                else -> postError(replyProxy, message.id, "UNSUPPORTED_TYPE", "Message type is not supported")
            }
        } catch (error: Exception) {
            postError(replyProxy, message.id, "INVALID_PAYLOAD", error.message ?: "Invalid payload")
        }
    }

    private fun handleEngineMessage(
        sourceView: WebView,
        raw: String?,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy
    ) {
        if (
            isDestroyedState || sourceView !== engineWebView || !isMainFrame ||
            !isExactAppAssetOrigin(sourceOrigin) || sourceView.url != ENGINE_URL
        ) {
            postError(replyProxy, safeMessageId(raw), "UNTRUSTED_SOURCE", "Untrusted engine source", "ENGINE")
            return
        }
        if (raw == null || !engineLimiter.tryAcquire()) {
            postError(replyProxy, safeMessageId(raw), "INVALID_MESSAGE", "Invalid engine message", "ENGINE")
            return
        }

        val message = try {
            BridgeProtocol.parse(raw, BridgeProtocol.MAX_MESSAGE_BYTES)
        } catch (error: Exception) {
            postError(replyProxy, safeMessageId(raw), "INVALID_MESSAGE", error.message ?: "Invalid message", "ENGINE")
            return
        }

        try {
            enforceEngineMessageSize(message, raw)
            validateEngineMetadata(message)
            when (message.type) {
                "runtime.response" -> routeRuntimeResponse(message)
                "device.profile.get" -> handleDeviceProfileRequest(message, replyProxy, full = true)
                "engine.ready" -> {
                    BridgeProtocol.requireOnlyKeys(message.payload, emptySet())
                    engineDocumentLoaded = true
                    engineRendererRecoveries = 0
                    enginePermanentlyUnavailable = false
                    postReply(
                        replyProxy,
                        BridgeProtocol.response(
                            message.id,
                            "engine.ready.response",
                            "engine",
                            JSONObject().put("ok", true),
                            "ENGINE"
                        )
                    )
                    flushQueuedRuntimeRequests()
                }
                else -> postError(replyProxy, message.id, "UNSUPPORTED_TYPE", "Engine message type is not supported", "ENGINE")
            }
        } catch (error: Exception) {
            postError(replyProxy, message.id, "INVALID_PAYLOAD", error.message ?: "Invalid payload", "ENGINE")
        }
    }

    private fun handleRuntimeRequest(
        message: BridgeProtocol.Message,
        replyProxy: JavaScriptReplyProxy,
        sourceOrigin: Uri
    ) {
        require(runtimeLimiter.tryAcquire()) { "Runtime rate exceeded" }
        if (enginePermanentlyUnavailable) {
            postError(replyProxy, message.id, "ENGINE_UNAVAILABLE", "Engine renderer is unavailable")
            return
        }
        require(pendingRuntime.size < MAX_PENDING_RUNTIME) { "Too many pending runtime requests" }
        require(!pendingRuntime.containsKey(message.id)) { "Duplicate runtime request id" }
        BridgeProtocol.validateRuntimePayload(message.payload)

        val runtimePayload = JSONObject(message.payload.toString())
        runtimePayload.put("sender", trustedSender(sourceOrigin))
        val envelope = JSONObject(message.envelope.toString())
            .put("v", BridgeProtocol.VERSION)
            .put("scope", BridgeProtocol.SCOPE)
            .put("source", "remote")
            .put("target", "ENGINE")
            .put("channel", "runtime")
            .put("type", "runtime.message")
            .put("payload", runtimePayload)

        val timeout = Runnable {
            completeRuntimeWithError(message.id, "ENGINE_TIMEOUT", "Engine response timed out")
        }
        pendingRuntime[message.id] = PendingRuntimeRequest(
            id = message.id,
            envelope = envelope.toString(),
            replyProxy = replyProxy,
            pageGeneration = pageGeneration,
            timeout = timeout
        )
        mainHandler.postDelayed(timeout, RUNTIME_TIMEOUT_MS)
        dispatchRuntimeRequest(message.id)
    }

    private fun dispatchRuntimeRequest(id: String) {
        val pending = pendingRuntime[id] ?: return
        if (!engineDocumentLoaded || !::engineWebView.isInitialized) return
        if (pending.state == DispatchState.DISPATCHED || pending.state == DispatchState.DISPATCHING) return
        if (pending.dispatchAttempts >= MAX_ENGINE_DISPATCH_ATTEMPTS) {
            completeRuntimeWithError(id, "ENGINE_UNAVAILABLE", "Engine host is unavailable")
            return
        }

        pending.state = DispatchState.DISPATCHING
        pending.dispatchAttempts++
        val quoted = quoteForJavaScript(pending.envelope)
        val script = """
            (function() {
              try {
                if (!window.CCEngineHost || typeof window.CCEngineHost.dispatchFromNative !== "function") return false;
                window.CCEngineHost.dispatchFromNative(JSON.parse($quoted));
                return true;
              } catch (_) {
                return false;
              }
            })();
        """.trimIndent()
        engineWebView.evaluateJavascript(script) { result ->
            val current = pendingRuntime[id] ?: return@evaluateJavascript
            if (result == "true") {
                current.state = DispatchState.DISPATCHED
            } else {
                current.state = DispatchState.QUEUED
                mainHandler.postDelayed({ dispatchRuntimeRequest(id) }, ENGINE_DISPATCH_RETRY_MS)
            }
        }
    }

    private fun flushQueuedRuntimeRequests() {
        pendingRuntime.keys.toList().forEach(::dispatchRuntimeRequest)
    }

    private fun routeRuntimeResponse(message: BridgeProtocol.Message) {
        val pending = pendingRuntime.remove(message.id) ?: return
        mainHandler.removeCallbacks(pending.timeout)
        if (pending.pageGeneration != pageGeneration || isDestroyedState) return
        val response = JSONObject(message.envelope.toString())
            .put("v", BridgeProtocol.VERSION)
            .put("scope", BridgeProtocol.SCOPE)
            .put("source", "engine")
            .put("target", "REMOTE")
            .put("channel", "runtime")
            .put("type", "runtime.response")
        postReply(pending.replyProxy, response.toString())
    }

    private fun handleStorageGet(message: BridgeProtocol.Message, replyProxy: JavaScriptReplyProxy) {
        require(storageLimiter.tryAcquire()) { "Storage rate exceeded" }
        BridgeProtocol.requireOnlyKeys(message.payload, emptySet())
        runAsyncRequest(message.id, replyProxy, durable = true) {
            AsyncResult("storage.response", "storage", storageRepository.state())
        }
    }

    private fun handleStoragePatch(message: BridgeProtocol.Message, replyProxy: JavaScriptReplyProxy) {
        require(storageLimiter.tryAcquire()) { "Storage rate exceeded" }
        BridgeProtocol.requireOnlyKeys(message.payload, setOf("baseRevision", "mutationId", "items", "keys", "clear"))
        val rawRevision = message.payload.opt("baseRevision") as? Number ?: throw IllegalArgumentException("Base revision is required")
        val baseRevision = rawRevision.toLong()
        require(rawRevision.toDouble() == baseRevision.toDouble() && baseRevision >= 0) { "Invalid base revision" }
        val mutationId = message.payload.getString("mutationId")
        val items = message.payload.optJSONObject("items") ?: throw IllegalArgumentException("Changed items are required")
        val array = message.payload.optJSONArray("keys") ?: throw IllegalArgumentException("Removed keys are required")
        require(array.length() <= AtomicStorageRepository.MAX_MUTATION_KEYS) { "Too many removed keys" }
        val keys = (0 until array.length()).map { array.getString(it) }
        val clear = message.payload.opt("clear") as? Boolean ?: throw IllegalArgumentException("Clear flag is required")
        runAsyncRequest(message.id, replyProxy, durable = true) {
            AsyncResult("storage.response", "storage", storageRepository.patch(baseRevision, mutationId, items, keys, clear), refreshBootstrap = true)
        }
    }

    private fun handleStorageSet(message: BridgeProtocol.Message, replyProxy: JavaScriptReplyProxy) {
        require(storageLimiter.tryAcquire()) { "Storage rate exceeded" }
        BridgeProtocol.requireOnlyKeys(message.payload, setOf("items"))
        val items = message.payload.optJSONObject("items")
            ?: throw IllegalArgumentException("Storage items are required")
        runAsyncRequest(message.id, replyProxy, durable = true) {
            storageRepository.set(items)
            AsyncResult(
                "storage.response",
                "storage",
                storageRepository.state().put("operation", "set"),
                refreshBootstrap = true
            )
        }
    }

    private fun handleStorageReplace(message: BridgeProtocol.Message, replyProxy: JavaScriptReplyProxy) {
        require(storageLimiter.tryAcquire()) { "Storage rate exceeded" }
        BridgeProtocol.requireOnlyKeys(message.payload, setOf("items"))
        val items = message.payload.optJSONObject("items")
            ?: throw IllegalArgumentException("Storage items are required")
        runAsyncRequest(message.id, replyProxy, durable = true) {
            storageRepository.replace(items)
            AsyncResult(
                "storage.response",
                "storage",
                storageRepository.state().put("operation", "replace"),
                refreshBootstrap = true
            )
        }
    }

    private fun handleStorageRemove(message: BridgeProtocol.Message, replyProxy: JavaScriptReplyProxy) {
        require(storageLimiter.tryAcquire()) { "Storage rate exceeded" }
        BridgeProtocol.requireOnlyKeys(message.payload, setOf("keys"))
        val array = message.payload.optJSONArray("keys")
            ?: throw IllegalArgumentException("Storage keys are required")
        require(array.length() <= AtomicStorageRepository.MAX_MUTATION_KEYS) { "Too many storage keys" }
        val keys = ArrayList<String>(array.length())
        for (index in 0 until array.length()) keys += array.getString(index)
        runAsyncRequest(message.id, replyProxy, durable = true) {
            storageRepository.remove(keys)
            AsyncResult(
                "storage.response",
                "storage",
                storageRepository.state().put("operation", "remove"),
                refreshBootstrap = true
            )
        }
    }

    private fun handleStorageClear(message: BridgeProtocol.Message, replyProxy: JavaScriptReplyProxy) {
        require(storageLimiter.tryAcquire()) { "Storage rate exceeded" }
        BridgeProtocol.requireOnlyKeys(message.payload, emptySet())
        runAsyncRequest(message.id, replyProxy, durable = true) {
            storageRepository.clear()
            AsyncResult(
                "storage.response",
                "storage",
                storageRepository.state().put("operation", "clear"),
                refreshBootstrap = true
            )
        }
    }

    private fun handleDeviceProfileRequest(
        message: BridgeProtocol.Message,
        replyProxy: JavaScriptReplyProxy,
        full: Boolean
    ) {
        require(profileLimiter.tryAcquire()) { "Profile rate exceeded" }
        BridgeProtocol.requireOnlyKeys(message.payload, emptySet())
        val profile = if (full) capabilityProfiler.fullProfile() else capabilityProfiler.coarseProfile()
        postReply(
            replyProxy,
            BridgeProtocol.response(
                id = message.id,
                type = "device.profile.response",
                channel = "device",
                target = if (full) "ENGINE" else "REMOTE",
                payload = JSONObject().put("ok", true).put("profile", profile)
            )
        )
    }

    private fun handlePlatformSwitch(message: BridgeProtocol.Message, replyProxy: JavaScriptReplyProxy) {
        require(platformLimiter.tryAcquire()) { "Platform switch rate exceeded" }
        BridgeProtocol.requireOnlyKeys(message.payload, setOf("platform"))
        val platform = Platform.fromWire(message.payload.optString("platform", ""))
            ?: throw IllegalArgumentException("Platform must be LICHESS or CHESS_COM")
        runAsyncRequest(message.id, replyProxy, durable = true) {
            storageRepository.set(JSONObject().put(PLATFORM_STORAGE_KEY, platform.storageValue))
            AsyncResult(
                "platform.switch.response",
                "platform",
                storageRepository.state().put("platform", platform.wireValue),
                refreshBootstrap = true,
                navigation = platform
            )
        }
    }

    private fun dispatchNativeTouch(
        view: WebView,
        action: Int,
        point: BridgeProtocol.TouchPoint,
        downTime: Long
    ): Boolean {
        val properties = MotionEvent.PointerProperties().apply {
            id = 0
            toolType = MotionEvent.TOOL_TYPE_FINGER
        }
        val coordinates = MotionEvent.PointerCoords().apply {
            x = point.x.toFloat()
            y = point.y.toFloat()
            pressure = if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) 0f else 1f
            size = 0.1f
        }
        val event = MotionEvent.obtain(
            downTime, SystemClock.uptimeMillis(), action, 1,
            arrayOf(properties), arrayOf(coordinates), 0, 0, 1f, 1f,
            0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0
        )
        dispatchingNativeTouch = true
        return try {
            view.dispatchTouchEvent(event)
        } finally {
            dispatchingNativeTouch = false
            event.recycle()
        }
    }

    private fun cancelPendingTouch(code: String, message: String) {
        nativeInput.cancelCurrent(code, message)
    }

    private fun runAsyncRequest(
        id: String,
        replyProxy: JavaScriptReplyProxy,
        durable: Boolean = false,
        operation: () -> AsyncResult
    ) {
        require(!pendingAsync.containsKey(id)) { "Duplicate async request id" }
        val pending = PendingAsyncRequest(id, replyProxy, pageGeneration, durable)
        pendingAsync[id] = pending
        pending.future = storageExecutor.submit {
            val result = try {
                operation()
            } catch (error: Exception) {
                AsyncResult(
                    "error",
                    "native",
                    JSONObject()
                        .put("ok", false)
                        .put(
                            "error",
                            JSONObject()
                                .put("code", (error as? StorageOperationException)?.code ?: "OPERATION_FAILED")
                                .put("message", (error.message ?: "Operation failed").take(256))
                        )
                )
            }
            mainHandler.post { completeAsyncRequest(id, result) }
        }
    }

    private fun completeAsyncRequest(id: String, result: AsyncResult) {
        if (result.refreshBootstrap) {
            storageRevision = result.payload.optLong("revision", storageRevision)
            if (!isDestroyedState && ::mainWebView.isInitialized) installDocumentStartScripts(mainWebView)
        }
        val pending = pendingAsync.remove(id) ?: return
        if (isDestroyedState || pending.pageGeneration != pageGeneration) return
        postReply(
            pending.replyProxy,
            BridgeProtocol.response(id, result.type, result.channel, result.payload)
        )
        result.navigation?.let { platform ->
            mainHandler.post {
                if (!isDestroyedState) mainWebView.loadUrl(platform.url)
            }
        }
    }

    private fun validateRemoteMetadata(message: BridgeProtocol.Message) {
        validateOptionalField(message.envelope, "source", "remote")
        validateOptionalField(message.envelope, "target", if (message.type == "runtime.message") "ENGINE" else "NATIVE")
        val expectedChannel = when {
            message.type.startsWith("runtime.") -> "runtime"
            message.type.startsWith("storage.") -> "storage"
            message.type.startsWith("device.") -> "device"
            message.type.startsWith("platform.") -> "platform"
            message.type.startsWith("project.") -> "project"
            message.type.startsWith("input.") -> "input"
            else -> "native"
        }
        validateOptionalField(message.envelope, "channel", expectedChannel)
    }

    private fun enforceRemoteMessageSize(message: BridgeProtocol.Message, raw: String) {
        val limit = when (message.type) {
            "runtime.message" -> BridgeProtocol.MAX_MESSAGE_BYTES
            "storage.set", "storage.replace", "storage.patch" -> AtomicStorageRepository.MAX_STORAGE_BYTES + 8 * 1024
            else -> BridgeProtocol.MAX_SMALL_MESSAGE_BYTES
        }
        require(raw.toByteArray(StandardCharsets.UTF_8).size <= limit) { "Message exceeds type limit" }
    }

    private fun enforceEngineMessageSize(message: BridgeProtocol.Message, raw: String) {
        val limit = if (message.type == "runtime.response") {
            BridgeProtocol.MAX_MESSAGE_BYTES
        } else {
            BridgeProtocol.MAX_SMALL_MESSAGE_BYTES
        }
        require(raw.toByteArray(StandardCharsets.UTF_8).size <= limit) { "Message exceeds type limit" }
    }

    private fun validateEngineMetadata(message: BridgeProtocol.Message) {
        validateOptionalField(message.envelope, "source", "engine")
        validateOptionalField(message.envelope, "target", if (message.type == "device.profile.get") "NATIVE" else "REMOTE")
        val expectedChannel = when {
            message.type.startsWith("runtime.") -> "runtime"
            message.type.startsWith("device.") -> "device"
            else -> "engine"
        }
        validateOptionalField(message.envelope, "channel", expectedChannel)
    }

    private fun validateOptionalField(envelope: JSONObject, name: String, expected: String) {
        if (envelope.has(name)) require(envelope.getString(name) == expected) { "Invalid $name" }
    }

    private fun trustedSender(sourceOrigin: Uri): JSONObject = JSONObject()
        .put("id", RUNTIME_ID)
        .put("url", mainWebView.url.orEmpty())
        .put("origin", trustedOrigin(sourceOrigin).orEmpty())
        .put("frameId", 0)
        .put("documentId", "android-$pageGeneration")
        .put("clientInstanceId", clientInstanceId)

    private fun postError(
        replyProxy: JavaScriptReplyProxy,
        id: String,
        code: String,
        message: String,
        target: String = "REMOTE"
    ) {
        try {
            postReply(replyProxy, BridgeProtocol.error(id, code, message, target))
        } catch (_: Exception) {
        }
    }

    private fun postReply(replyProxy: JavaScriptReplyProxy, message: String) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        replyProxy.postMessage(message)
    }

    private fun completeRuntimeWithError(id: String, code: String, message: String) {
        val pending = pendingRuntime.remove(id) ?: return
        mainHandler.removeCallbacks(pending.timeout)
        postError(pending.replyProxy, id, code, message)
    }

    private fun cancelRuntimeRequests(code: String, message: String) {
        pendingRuntime.keys.toList().forEach { completeRuntimeWithError(it, code, message) }
    }

    private fun cancelRemoteWork(code: String, message: String) {
        cancelPendingTouch(code, message)
        cancelRuntimeRequests(code, message)
        val requests = pendingAsync.values.toList()
        pendingAsync.clear()
        requests.forEach {
            if (!it.durable) it.future?.cancel(true)
            postError(it.replyProxy, it.id, code, message)
        }
    }

    private fun installDocumentStartScripts(view: WebView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
        documentStartHandler?.remove()
        privacyStartHandler?.remove()
        documentStartHandler = null
        privacyStartHandler = null

        val polyfill = readAssetText("bridge/cc-android-polyfill.js") ?: return
        val profile = capabilityProfiler.coarseProfile()
            .put("runtimeId", RUNTIME_ID)
            .put("documentId", "android-$pageGeneration")
            .put("clientInstanceId", clientInstanceId)
        val stored = try {
            storageRepository.state()
        } catch (_: StorageOperationException) {
            JSONObject().put("ok", false).put("items", JSONObject()).put("revision", storageRevision)
        }
        storageRevision = stored.optLong("revision", storageRevision)
        val bootstrap = JSONObject()
            .put("v", BridgeProtocol.VERSION)
            .put("storage", stored.getJSONObject("items"))
            .put("storageRevision", storageRevision)
            .put("storageReady", stored.optBoolean("ok"))
            .put("profile", profile)
        val quotedBootstrap = quoteForJavaScript(bootstrap.toString())
        val privacyScript = readAssetText("content/privacy-mask-bootstrap.js").orEmpty()
        documentStartHandler = WebViewCompat.addDocumentStartJavaScript(
            view,
            buildDocumentStartScript(polyfill, quotedBootstrap, ""),
            setOf(LICHESS_ORIGIN)
        )
        privacyStartHandler = WebViewCompat.addDocumentStartJavaScript(
            view,
            buildDocumentStartScript(polyfill, quotedBootstrap, privacyScript),
            setOf(CHESS_COM_ORIGIN)
        )
    }

    private fun buildDocumentStartScript(
        polyfill: String,
        quotedBootstrap: String,
        privacyScript: String
    ): String {
        val privacyBootstrap = if (privacyScript.isBlank()) {
            ""
        } else {
            """
                const chrome = window.__CC_ANDROID_RUNTIME__ && window.__CC_ANDROID_RUNTIME__.chrome;
                if (!chrome) throw new Error("Android runtime unavailable for privacy bootstrap");
                $privacyScript
            """.trimIndent()
        }
        return """
            (function() {
              "use strict";
              if (window.__CC_ANDROID_BOOTSTRAP_READY__ === true) return;
              try {
                const bootstrap = JSON.parse($quotedBootstrap);
                Object.defineProperty(window, "__CC_ANDROID_BOOTSTRAP__", {
                  value: bootstrap, configurable: false, enumerable: false, writable: false
                });
                Object.defineProperty(window, "__CC_DEVICE_PROFILE__", {
                  value: bootstrap.profile, configurable: false, enumerable: false, writable: false
                });
                $polyfill
                $privacyBootstrap
                Object.defineProperty(window, "__CC_ANDROID_BOOTSTRAP_READY__", {
                  value: true, configurable: false, enumerable: false, writable: false
                });
              } catch (error) {
                console.error("[ChessCoach Android] bootstrap failed", error);
              }
            })();
        """.trimIndent()
    }

    private fun injectMainBundle(view: WebView, url: String, generation: Long, attempt: Int) {
        val platform = platformForUri(Uri.parse(url)) ?: return
        val cached = bundleCache[platform]
        if (cached != null) {
            evaluateBundle(view, cached, url, generation, attempt)
            return
        }
        bundleExecutor.submit {
            val bundle = buildMainBundle(platform)
            if (bundle != null) bundleCache[platform] = bundle
            mainHandler.post {
                if (bundle != null && !isDestroyedState) {
                    evaluateBundle(view, bundle, url, generation, attempt)
                }
            }
        }
    }

    private fun evaluateBundle(
        view: WebView,
        bundle: String,
        url: String,
        generation: Long,
        attempt: Int
    ) {
        if (
            isDestroyedState || view !== mainWebView || generation != pageGeneration ||
            view.url != url || !isTrustedRemoteUri(Uri.parse(url))
        ) return
        view.evaluateJavascript(bundle) { result ->
            if (result == "\"ready\"") return@evaluateJavascript
            if (attempt < MAX_BUNDLE_RETRIES && generation == pageGeneration && !isDestroyedState) {
                mainHandler.postDelayed(
                    { injectMainBundle(view, url, generation, attempt + 1) },
                    BUNDLE_RETRY_MS
                )
            }
        }
    }

    private fun buildMainBundle(platform: Platform): String? {
        val paths = ArrayList<String>()
        paths += "bridge/cc-mobile-preferences.js"
        paths += "bridge/cc-mobile-session.js"
        paths += "lib/openings.js"
        paths += "lib/explainer.js"
        paths += "lib/phonk-fx.js"
        if (platform == Platform.CHESS_COM) paths += "lib/privacy-mask.js"
        paths += "lib/engine-client.js"
        paths += "bridge/cc-mobile-launcher-orb.js"
        paths += if (platform == Platform.CHESS_COM) "content/chesscom.js" else "content/content.js"

        val sources = paths.map { path -> readAssetText(path) ?: return null }
        return buildString(sources.sumOf(String::length) + 1024) {
            append("(function(){\n\"use strict\";\n")
            append("if(window.__ccAndroidBundleState===\"ready\")return \"ready\";\n")
            append("if(window.__ccAndroidBundleState===\"loading\")return \"loading\";\n")
            append("window.__ccAndroidBundleState=\"loading\";\n")
            append("try{\n")
            append("if(window.__CC_ANDROID_BOOTSTRAP_READY__!==true)throw new Error(\"Native bootstrap unavailable\");\n")
            append("const chrome=window.__CC_ANDROID_RUNTIME__&&window.__CC_ANDROID_RUNTIME__.chrome;\n")
            append("if(!chrome)throw new Error(\"Android runtime unavailable\");\n")
            for (source in sources) append(source).append("\n;\n")
            append("window.__ccAndroidBundleState=\"ready\";\n")
            append("Object.defineProperty(window,\"__ccAndroidBundleReady\",{value:true,configurable:false});\n")
            append("window.dispatchEvent(new CustomEvent(\"cc-android-ready\"));\n")
            append("return \"ready\";\n")
            append("}catch(error){window.__ccAndroidBundleState=\"failed\";console.error(\"[ChessCoach Android] bundle failed\",error);return \"failed\";}\n")
            append("})();")
        }
    }

    private fun interceptRemotePackagedAsset(request: WebResourceRequest): WebResourceResponse? {
        val uri = request.url
        if (!isTrustedRemoteUri(uri)) return null
        val encodedPath = uri.encodedPath ?: return null
        if (!encodedPath.startsWith(REMOTE_ASSET_PREFIX)) return null
        if (!request.method.equals("GET", ignoreCase = true)) return forbiddenResponse()

        val encodedRelative = encodedPath.removePrefix(REMOTE_ASSET_PREFIX)
        if (
            encodedRelative.isBlank() || encodedRelative.contains('%') || encodedRelative.contains('\\') ||
            encodedRelative.startsWith('/') || encodedRelative.split('/').any { it == "." || it == ".." }
        ) return forbiddenResponse()
        if (encodedRelative !in REMOTE_ASSET_ALLOWLIST) return forbiddenResponse()

        val origin = trustedOrigin(uri) ?: return forbiddenResponse()
        val mime = mimeTypeForAsset(encodedRelative)
        val encoding = if (mime.startsWith("text/") || mime.contains("javascript")) "UTF-8" else null
        val headers = mapOf(
            "Access-Control-Allow-Origin" to origin,
            "Access-Control-Allow-Methods" to "GET",
            "Cache-Control" to "no-store",
            "Vary" to "Origin",
            "X-Content-Type-Options" to "nosniff"
        )
        return try {
            WebResourceResponse(
                mime,
                encoding,
                200,
                "OK",
                headers,
                assets.open(encodedRelative)
            )
        } catch (_: Exception) {
            WebResourceResponse(
                "text/plain",
                "UTF-8",
                404,
                "Not Found",
                headers,
                ByteArrayInputStream("Not Found".toByteArray(StandardCharsets.UTF_8))
            )
        }
    }

    private fun forbiddenResponse(): WebResourceResponse = WebResourceResponse(
        "text/plain",
        "UTF-8",
        403,
        "Forbidden",
        mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff"),
        ByteArrayInputStream("Forbidden".toByteArray(StandardCharsets.UTF_8))
    )

    private fun mimeTypeForAsset(path: String): String = when {
        path.endsWith(".css") -> "text/css"
        path.endsWith(".js") -> "application/javascript"
        path.endsWith(".png") -> "image/png"
        path.endsWith(".jpg") || path.endsWith(".jpeg") -> "image/jpeg"
        else -> "application/octet-stream"
    }

    private fun installDocumentStartScriptsAfterResume() {
        if (::mainWebView.isInitialized && !isDestroyedState) installDocumentStartScripts(mainWebView)
    }

    private fun registerDeviceStateListeners() {
        ContextCompat.registerReceiver(
            this,
            powerSaveReceiver,
            IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        powerReceiverRegistered = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val powerManager = getSystemService(PowerManager::class.java) ?: return
            val listener = PowerManager.OnThermalStatusChangedListener {
                publishCurrentDeviceProfile()
            }
            powerManager.addThermalStatusListener(mainExecutor, listener)
            removeThermalListener = { powerManager.removeThermalStatusListener(listener) }
        }
    }

    private fun publishCurrentDeviceProfile(resumeEngine: Boolean = false) {
        if (isDestroyedState || !isResumedState) return
        val profile = capabilityProfiler.coarseProfile()
            .put("runtimeId", RUNTIME_ID)
            .put("documentId", "android-$pageGeneration")
            .put("clientInstanceId", clientInstanceId)
        val quotedProfile = quoteForJavaScript(profile.toString())
        if (::mainWebView.isInitialized && isTrustedRemoteUri(Uri.parse(mainWebView.url.orEmpty()))) {
            val envelope = BridgeProtocol.response(
                "profile-${SystemClock.elapsedRealtime()}",
                "profile.update",
                "device",
                JSONObject().put("profile", profile)
            )
            mainWebView.evaluateJavascript(
                """
                    (function() {
                      const bridge = window.CCNative;
                      if (bridge && typeof bridge.onmessage === "function") bridge.onmessage(${quoteForJavaScript(envelope)});
                      window.dispatchEvent(new CustomEvent("cc-device-profile-ready"));
                    })();
                """.trimIndent(),
                null
            )
        }
        if (::engineWebView.isInitialized && !engineNeedsReload && engineWebView.url == ENGINE_URL) {
            val method = if (resumeEngine) "resumeForApp" else "refreshDeviceProfileForApp"
            engineWebView.evaluateJavascript(
                "window.CCEngineHost && window.CCEngineHost.$method(JSON.parse($quotedProfile));",
                null
            )
        }
    }

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                handleBrowserBack()
            }
        })
    }

    private fun handleBrowserBack() {
        if (isDestroyedState) return
        popupWebView?.let { popup ->
            if (canAdoptAuthenticationWindow(popup)) {
                adoptAuthenticationWindow(popup, popup.url.orEmpty())
                return
            }
            val history = popup.copyBackForwardList()
            val previous = if (history.currentIndex > 0) history.getItemAtIndex(history.currentIndex - 1)?.url else null
            if (previous != null && BrowserNavigationPolicy.classify(previous) in setOf(BrowserNavigationPolicy.Destination.GAME, BrowserNavigationPolicy.Destination.WEB, BrowserNavigationPolicy.Destination.CREDITS)) popup.goBack()
            else closeBrowserPopup()
            return
        }
        val generation = pageGeneration
        val initiatingView = mainWebView
        initiatingView.evaluateJavascript("Boolean(window.__ccHandleAndroidBack && window.__ccHandleAndroidBack());") { handled ->
            if (isDestroyedState || !isResumedState || popupWebView != null || initiatingView !== mainWebView || generation != pageGeneration || handled == "true") return@evaluateJavascript
            val history = initiatingView.copyBackForwardList()
            val previous = if (history.currentIndex > 0) history.getItemAtIndex(history.currentIndex - 1)?.url else null
            flushPreferencesBeforeNavigation(initiatingView) {
                if (!isDestroyedState && isResumedState && popupWebView == null && initiatingView === mainWebView && generation == pageGeneration) {
                    if (previous != null && BrowserNavigationPolicy.classify(previous) == BrowserNavigationPolicy.Destination.GAME) initiatingView.goBack()
                    else finishAfterTransition()
                }
            }
        }
    }

    private fun restoreTrustedState(savedInstanceState: Bundle?): Boolean {
        if (savedInstanceState == null) return false
        return try {
            val restored = mainWebView.restoreState(savedInstanceState) ?: return false
            val history = mainWebView.copyBackForwardList()
            val valid = history.size > 0 && (0 until history.size).all { index ->
                val url = history.getItemAtIndex(index)?.url ?: return@all false
                BrowserNavigationPolicy.classify(url) == BrowserNavigationPolicy.Destination.GAME
            }
            if (!valid || BrowserNavigationPolicy.classify(restored.currentItem?.url.orEmpty()) != BrowserNavigationPolicy.Destination.GAME) {
                mainWebView.stopLoading()
                mainWebView.clearHistory()
                false
            } else {
                true
            }
        } catch (_: Exception) {
            false
        }
    }

    private fun lastPlatform(): Platform {
        return when (storageRepository.snapshot().optString(PLATFORM_STORAGE_KEY, Platform.LICHESS.storageValue)) {
            Platform.CHESS_COM.storageValue -> Platform.CHESS_COM
            else -> Platform.LICHESS
        }
    }

    private fun openExternal(uri: Uri) {
        val scheme = uri.scheme?.lowercase() ?: return
        if (scheme !in setOf("https", "mailto", "tel")) return
        try {
            if (scheme == "https") {
                CustomTabsIntent.Builder()
                    .setDefaultColorSchemeParams(CustomTabColorSchemeParams.Builder().setToolbarColor("#101A25".toColorInt()).build())
                    .setShowTitle(true)
                    .setShareState(CustomTabsIntent.SHARE_STATE_OFF)
                    .build().launchUrl(this, uri)
            } else {
                startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE).setComponent(null))
            }
        } catch (_: Exception) {
            Toast.makeText(this, "Нет приложения для открытия ссылки", Toast.LENGTH_LONG).show()
        }
    }

    private fun isTrustedRemoteUri(uri: Uri): Boolean = trustedOrigin(uri) != null

    private fun trustedOrigin(uri: Uri): String? {
        if (!uri.isHierarchical || !uri.scheme.equals("https", ignoreCase = true)) return null
        if (!uri.encodedUserInfo.isNullOrEmpty()) return null
        if (uri.port != -1 && uri.port != 443) return null
        val host = uri.host?.lowercase() ?: return null
        val authority = uri.encodedAuthority?.lowercase() ?: return null
        if (authority != host && authority != "$host:443") return null
        return when (host) {
            LICHESS_HOST -> LICHESS_ORIGIN
            CHESS_COM_HOST -> CHESS_COM_ORIGIN
            else -> null
        }
    }

    private fun platformForUri(uri: Uri): Platform? = when (trustedOrigin(uri)) {
        LICHESS_ORIGIN -> Platform.LICHESS
        CHESS_COM_ORIGIN -> Platform.CHESS_COM
        else -> null
    }

    private fun isExactAppAssetOrigin(uri: Uri): Boolean {
        val authority = uri.encodedAuthority?.lowercase()
        return uri.isHierarchical && uri.scheme.equals("https", ignoreCase = true) &&
            uri.host.equals(APP_ASSET_HOST, ignoreCase = true) &&
            (uri.port == -1 || uri.port == 443) &&
            uri.encodedUserInfo.isNullOrEmpty() &&
            (authority == APP_ASSET_HOST || authority == "$APP_ASSET_HOST:443")
    }

    private fun isAppAssetUri(uri: Uri): Boolean = isExactAppAssetOrigin(uri)

    private fun isAllowedEngineNetworkUri(uri: Uri): Boolean {
        if (!uri.isHierarchical || !uri.scheme.equals("https", ignoreCase = true)) return false
        if (!uri.encodedUserInfo.isNullOrEmpty()) return false
        if (uri.port != -1 && uri.port != 443) return false
        val host = uri.host?.lowercase() ?: return false
        val authority = uri.encodedAuthority?.lowercase() ?: return false
        return host in ENGINE_NETWORK_HOSTS && (authority == host || authority == "$host:443")
    }

    private fun bridgeFeaturesAvailable(): Boolean {
        return WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
    }

    private fun readAssetText(path: String): String? = try {
        assets.open(path).bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
    } catch (_: Exception) {
        null
    }

    private fun quoteForJavaScript(value: String): String {
        return JSONObject.quote(value)
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029")
            .replace("</", "<\\/")
    }

    private fun safeMessageId(raw: String?): String {
        if (raw == null || raw.length > BridgeProtocol.MAX_MESSAGE_BYTES) return "invalid"
        return try {
            val candidate = JSONObject(raw).optString("id", "")
            if (MESSAGE_ID_PATTERN.matches(candidate)) candidate else "invalid"
        } catch (_: Exception) {
            "invalid"
        }
    }

    private fun runOnMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post(block)
    }

    private fun recoverMainRenderer(didCrash: Boolean) {
        cancelRemoteWork("RENDERER_GONE", "Remote renderer was restarted")
        closeAllBrowserPopups(restoreMain = false)
        val recoveryUrl = mainWebView.url?.takeIf { isTrustedRemoteUri(Uri.parse(it)) } ?: lastPlatform().url
        val oldView = mainWebView
        mainHandler.post {
            if (isDestroyedState) return@post
            mainRendererRecoveries++
            detachAndDestroyWebView(oldView, REMOTE_BRIDGE_NAME)
            mainWebView = createMainWebView()
            browserContainer.addView(mainWebView)
            mainWebView.loadUrl(recoveryUrl)
            if (didCrash && mainRendererRecoveries <= MAX_RENDERER_RECOVERIES) {
                Toast.makeText(this, "WebView перезапущен после сбоя", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun recoverEngineRenderer(didCrash: Boolean) {
        cancelRuntimeRequests("ENGINE_RENDERER_GONE", "Engine renderer was restarted")
        engineDocumentLoaded = false
        val oldView = engineWebView
        mainHandler.post {
            if (isDestroyedState) return@post
            engineRendererRecoveries++
            detachAndDestroyWebView(oldView, ENGINE_BRIDGE_NAME)
            if (engineRendererRecoveries > MAX_RENDERER_RECOVERIES) {
                enginePermanentlyUnavailable = true
                if (didCrash) Toast.makeText(this, "Шахматный движок временно недоступен", Toast.LENGTH_LONG).show()
                return@post
            }
            engineWebView = createEngineWebView()
            rootLayout.addView(engineWebView, 0)
            mainHandler.postDelayed({
                if (!isDestroyedState) engineWebView.loadUrl(ENGINE_URL)
            }, ENGINE_RECOVERY_DELAY_MS)
        }
    }

    private fun detachAndDestroyWebView(view: WebView, bridgeName: String) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            try {
                WebViewCompat.removeWebMessageListener(view, bridgeName)
            } catch (_: Exception) {
            }
        }
        try {
            (view.parent as? ViewGroup)?.removeView(view)
            view.stopLoading()
            view.removeAllViews()
            view.destroy()
        } catch (_: Exception) {
        }
    }

    override fun onResume() {
        super.onResume()
        appLifecycleGeneration++
        isResumedState = true
        if (::mainWebView.isInitialized) {
            if (popupWebView == null) resumeMainBrowser()
            mainWebView.resumeTimers()
        }
        popupWebView?.onResume()
        if (engineNeedsReload) {
            engineNeedsReload = false
            engineWebView = createEngineWebView().also { rootLayout.addView(it, 0) }
            engineWebView.loadUrl(ENGINE_URL)
        } else if (::engineWebView.isInitialized) {
            engineWebView.onResume()
        }
        installDocumentStartScriptsAfterResume()
        publishCurrentDeviceProfile(resumeEngine = true)
    }

    override fun onPause() {
        isResumedState = false
        val generation = ++appLifecycleGeneration
        cancelRemoteWork("APP_PAUSED", "Activity is paused")
        CookieManager.getInstance().flush()
        popupWebView?.onPause()
        if (::mainWebView.isInitialized) {
            mainWebView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('cc-mobile-lifecycle',{detail:{state:'hidden',cancelPendingMoves:true}}));",
                null
            )
            mainWebView.onPause()
        }
        if (::engineWebView.isInitialized && !engineNeedsReload) {
            val view = engineWebView
            val stopTimeout = Runnable {
                if (isDestroyedState || isResumedState || generation != appLifecycleGeneration || view !== engineWebView) return@Runnable
                engineDocumentLoaded = false
                engineNeedsReload = true
                detachAndDestroyWebView(view, ENGINE_BRIDGE_NAME)
                if (::mainWebView.isInitialized) mainWebView.pauseTimers()
            }
            mainHandler.postDelayed(stopTimeout, 1_000L)
            // Worker termination must execute before globally freezing WebView timers.
            view.evaluateJavascript(
                "(function(){if(window.CCEngineHost)window.CCEngineHost.suspendForApp();return 'suspended';})();"
            ) { result ->
                mainHandler.removeCallbacks(stopTimeout)
                if (isDestroyedState || isResumedState || generation != appLifecycleGeneration || view !== engineWebView) return@evaluateJavascript
                if (result != "\"suspended\"") stopTimeout.run()
                else if (::mainWebView.isInitialized) mainWebView.pauseTimers()
            }
            view.onPause()
        } else if (::mainWebView.isInitialized) {
            mainWebView.pauseTimers()
        }
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) cancelPendingTouch("INPUT_FOCUS_LOST", "The activity lost focus")
    }

    override fun onSaveInstanceState(outState: Bundle) {
        if (::mainWebView.isInitialized && BrowserNavigationPolicy.classify(mainWebView.url.orEmpty()) == BrowserNavigationPolicy.Destination.GAME) {
            mainWebView.saveState(outState)
        }
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        isDestroyedState = true
        googleSignInDialog?.dismiss()
        loadErrorDialog?.dismiss()
        closeAllBrowserPopups(restoreMain = false)
        removeThermalListener?.invoke()
        removeThermalListener = null
        if (powerReceiverRegistered) {
            unregisterReceiver(powerSaveReceiver)
            powerReceiverRegistered = false
        }
        cancelRemoteWork("APP_DESTROYED", "Activity was destroyed")
        documentStartHandler?.remove()
        privacyStartHandler?.remove()
        documentStartHandler = null
        privacyStartHandler = null
        mainHandler.removeCallbacksAndMessages(null)
        storageExecutor.shutdown()
        bundleExecutor.shutdownNow()
        if (::mainWebView.isInitialized) detachAndDestroyWebView(mainWebView, REMOTE_BRIDGE_NAME)
        if (::engineWebView.isInitialized) detachAndDestroyWebView(engineWebView, ENGINE_BRIDGE_NAME)
        super.onDestroy()
    }

    private enum class Platform(
        val wireValue: String,
        val storageValue: String,
        val url: String
    ) {
        LICHESS("LICHESS", "lichess", "https://lichess.org/"),
        CHESS_COM("CHESS_COM", "chesscom", "https://www.chess.com/play/online");

        companion object {
            fun fromWire(value: String): Platform? = entries.firstOrNull { it.wireValue == value }
        }
    }

    private data class PendingRuntimeRequest(
        val id: String,
        val envelope: String,
        val replyProxy: JavaScriptReplyProxy,
        val pageGeneration: Long,
        val timeout: Runnable,
        var state: DispatchState = DispatchState.QUEUED,
        var dispatchAttempts: Int = 0
    )

    private data class PendingAsyncRequest(
        val id: String,
        val replyProxy: JavaScriptReplyProxy,
        val pageGeneration: Long,
        val durable: Boolean = false,
        @Volatile var future: Future<*>? = null
    )

    private data class AsyncResult(
        val type: String,
        val channel: String,
        val payload: JSONObject,
        val refreshBootstrap: Boolean = false,
        val navigation: Platform? = null
    )

    private enum class DispatchState { QUEUED, DISPATCHING, DISPATCHED }

    private class SlidingWindowLimiter(
        private val capacity: Int,
        private val windowMs: Long
    ) {
        private val timestamps = ArrayDeque<Long>()

        @Synchronized
        fun tryAcquire(now: Long = android.os.SystemClock.elapsedRealtime()): Boolean {
            while (timestamps.isNotEmpty() && now - timestamps.first() >= windowMs) {
                timestamps.removeFirst()
            }
            if (timestamps.size >= capacity) return false
            timestamps.addLast(now)
            return true
        }
    }

    companion object {
        private const val LICHESS_HOST = "lichess.org"
        private const val CHESS_COM_HOST = "www.chess.com"
        private const val LICHESS_ORIGIN = "https://lichess.org"
        private const val CHESS_COM_ORIGIN = "https://www.chess.com"
        private val REMOTE_ORIGINS = setOf(LICHESS_ORIGIN, CHESS_COM_ORIGIN)
        private const val APP_ASSET_HOST = "appassets.androidplatform.net"
        private const val APP_ASSET_ORIGIN = "https://appassets.androidplatform.net"
        private val ENGINE_NETWORK_HOSTS = setOf(
            "lichess.org",
            "explorer.lichess.ovh",
            "tablebase.lichess.ovh"
        )
        private const val ENGINE_URL = "$APP_ASSET_ORIGIN/assets/engine/engine-host.html"
        private const val REMOTE_BRIDGE_NAME = "CCNative"
        private const val ENGINE_BRIDGE_NAME = "CCEngineNative"
        private const val RUNTIME_ID = "chesscoach_android_v1"
        private const val PLATFORM_STORAGE_KEY = "cc_mobile_platform"
        private const val REMOTE_ASSET_PREFIX = "/__cc_assets/"
        private const val RUNTIME_TIMEOUT_MS = 70_000L
        private const val ENGINE_DISPATCH_RETRY_MS = 250L
        private const val ENGINE_RECOVERY_DELAY_MS = 500L
        private const val BUNDLE_RETRY_MS = 500L
        private const val MAX_PENDING_RUNTIME = 24
        private const val MAX_ENGINE_DISPATCH_ATTEMPTS = 8
        private const val MAX_BUNDLE_RETRIES = 2
        private const val MAX_RENDERER_RECOVERIES = 3
        private val MESSAGE_ID_PATTERN = Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,63}")
        private val REMOTE_ASSET_ALLOWLIST = setOf(
            "content/content.css",
            "lib/stockfish-local.js"
        )
    }
}
