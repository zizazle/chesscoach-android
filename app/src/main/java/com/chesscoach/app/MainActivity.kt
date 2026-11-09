package com.chesscoach.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.MediaStore
import android.util.Base64
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileOutputStream

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private lateinit var storageFile: File
    private lateinit var userScriptsDir: File

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null

        if (result.resultCode != Activity.RESULT_OK || result.data == null) {
            callback.onReceiveValue(null)
            return@registerForActivityResult
        }

        val data = result.data!!
        val uris = mutableListOf<Uri>()
        if (data.clipData != null) {
            val count = data.clipData!!.itemCount
            for (i in 0 until count) {
                uris.add(data.clipData!!.getItemAt(i).uri)
            }
        } else if (data.data != null) {
            uris.add(data.data!!)
        }

        callback.onReceiveValue(uris.toTypedArray())
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.statusBarColor = Color.parseColor("#06080E")
        window.navigationBarColor = Color.parseColor("#06080E")
        WindowCompat.setDecorFitsSystemWindows(window, true)

        storageFile = File(filesDir, "cc_storage_v15.json")
        if (!storageFile.exists()) {
            storageFile.writeText("{}")
        }

        userScriptsDir = File(filesDir, "user_scripts")
        if (!userScriptsDir.exists()) {
            userScriptsDir.mkdirs()
        }

        val rootLayout = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#06080E"))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        webView = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#06080E"))
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }

        rootLayout.addView(webView)
        setContentView(rootLayout)

        setupWebView()
        setupBackNavigation()

        val initialUrl = getLastPlatformUrl()
        webView.loadUrl(initialUrl)
    }

    private fun getLastPlatformUrl(): String {
        return try {
            val json = JSONObject(storageFile.readText())
            when (json.optString("cc_mobile_platform", "lichess")) {
                "chesscom" -> "https://www.chess.com/play/online"
                else -> "https://lichess.org/"
            }
        } catch (e: Exception) {
            "https://lichess.org/"
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "RequiresFeature")
    private fun setupWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.allowFileAccess = true
        settings.allowContentAccess = true
        settings.loadWithOverviewMode = false
        settings.useWideViewPort = false
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW

        val defaultUa = settings.userAgentString
        settings.userAgentString = defaultUa
            .replace("; wv", "")
            .replace(Regex("Version/\\d+\\.\\d+\\s+"), "")

        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(webView, true)

        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        webView.addJavascriptInterface(AndroidBridge(), "CCAndroidBridge")

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain("appassets.androidplatform.net")
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            val startScript = buildDocumentStartScript()
            WebViewCompat.addDocumentStartJavaScript(
                webView,
                startScript,
                setOf("https://lichess.org", "https://*.lichess.org", "https://chess.com", "https://*.chess.com")
            )
        }

        webView.webViewClient = object : WebViewClient() {

            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                val url = request.url
                if (url.host == "appassets.androidplatform.net") {
                    val path = url.path ?: ""
                    if (path.startsWith("/assets/user_scripts/")) {
                        val fileName = path.removePrefix("/assets/user_scripts/")
                        val customFile = File(userScriptsDir, fileName)
                        if (customFile.exists()) {
                            return createCorsResponse("application/javascript", customFile.readBytes())
                        }
                    }

                    val resp = assetLoader.shouldInterceptRequest(url)
                    if (resp != null) {
                        val headers = HashMap<String, String>()
                        resp.responseHeaders?.let { headers.putAll(it) }
                        headers["Access-Control-Allow-Origin"] = "*"
                        headers["Access-Control-Allow-Methods"] = "GET, OPTIONS"
                        headers["Access-Control-Allow-Headers"] = "*"
                        headers["Cache-Control"] = "no-store"
                        resp.responseHeaders = headers
                        return resp
                    }
                }
                return super.shouldInterceptRequest(view, request)
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                    view.evaluateJavascript(buildDocumentStartScript(), null)
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                CookieManager.getInstance().flush()
                injectMainChessCoachBundle(url)
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onJsBeforeUnload(
                view: WebView?,
                url: String?,
                message: String?,
                result: android.webkit.JsResult?
            ): Boolean {
                // Автоматически разрешаем переключение между Lichess и Chess.com даже посреди партии
                result?.confirm()
                return true
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                this@MainActivity.filePathCallback?.onReceiveValue(null)
                this@MainActivity.filePathCallback = filePathCallback

                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, fileChooserParams.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
                }
                fileChooserLauncher.launch(Intent.createChooser(intent, "Выберите файл для ChessCoach"))
                return true
            }
        }
    }

    private fun createCorsResponse(mime: String, bytes: ByteArray): WebResourceResponse {
        val headers = mapOf(
            "Access-Control-Allow-Origin" to "*",
            "Access-Control-Allow-Methods" to "GET, OPTIONS",
            "Cache-Control" to "no-store"
        )
        return WebResourceResponse(mime, "UTF-8", 200, "OK", headers, ByteArrayInputStream(bytes))
    }

    private fun readAssetTextSafe(relPath: String): String {
        return try {
            assets.open(relPath).bufferedReader(Charsets.UTF_8).use { it.readText() }
        } catch (e: Exception) {
            ""
        }
    }

    private fun buildDocumentStartScript(): String {
        val mainBridgeCode = readAssetTextSafe("content/main-bridge.js")
        return """
            (function() {
                if (window.__ccDocStartDone) return;
                window.__ccDocStartDone = true;
                var host = location.hostname || "";
                if (host.indexOf("lichess.org") !== -1) {
                    try {
                        $mainBridgeCode
                    } catch (e) {}
                }
            })();
        """.trimIndent()
    }

    /**
     * ВАЖНО: Сначала инжектится polyfillJs + mobileLauncherOrbJs (чтобы перехватить attachShadow
     * и вшить content.css напрямую), и только потом запускается content.js / chesscom.js!
     */
    private fun injectMainChessCoachBundle(url: String) {
        val host = Uri.parse(url).host?.lowercase() ?: ""
        val isLichess = host.contains("lichess.org")
        val isChessCom = host.contains("chess.com")
        if (!isLichess && !isChessCom) return

        val polyfillJs = readAssetTextSafe("bridge/cc-android-polyfill.js")
        val backgroundJs = readAssetTextSafe("background/background.js")
        val openingsJs = readAssetTextSafe("lib/openings.js")
        val explainerJs = readAssetTextSafe("lib/explainer.js")
        val phonkFxJs = readAssetTextSafe("lib/phonk-fx.js")
        val mobileLauncherOrbJs = readAssetTextSafe("bridge/cc-mobile-launcher-orb.js")
        val scriptApiJs = readAssetTextSafe("lib/script-api.js")
        val platformCoreJs = if (isChessCom) {
            readAssetTextSafe("content/chesscom.js")
        } else {
            readAssetTextSafe("content/content.js")
        }
        val sampleScriptJs = readAssetTextSafe("scripts/sample.js")

        val fullBundle = StringBuilder(550_000)
        fullBundle.append("(function(){\n")
        fullBundle.append("if (window.__ccAndroidBundleInjected) return;\n")
        fullBundle.append("window.__ccAndroidBundleInjected = true;\n")
        fullBundle.append("try {\n").append(polyfillJs).append("\n} catch(e){ console.error('Polyfill err', e); }\n")
        fullBundle.append("try {\n").append(backgroundJs).append("\n} catch(e){ console.error('BG err', e); }\n")
        fullBundle.append("try {\n").append(openingsJs).append("\n} catch(e){ console.error('Openings err', e); }\n")
        fullBundle.append("try {\n").append(explainerJs).append("\n} catch(e){ console.error('Explainer err', e); }\n")
        fullBundle.append("try {\n").append(phonkFxJs).append("\n} catch(e){ console.error('PhonkFX err', e); }\n")
        fullBundle.append("try {\n").append(mobileLauncherOrbJs).append("\n} catch(e){ console.error('Launcher err', e); }\n")
        fullBundle.append("try {\n").append(scriptApiJs).append("\n} catch(e){ console.error('ScriptAPI err', e); }\n")
        fullBundle.append("try {\n").append(platformCoreJs).append("\n} catch(e){ console.error('Core err', e); }\n")
        fullBundle.append("try {\n").append(sampleScriptJs).append("\n} catch(e){ console.error('Sample err', e); }\n")
        fullBundle.append("})();")

        webView.evaluateJavascript(fullBundle.toString(), null)
    }

    private fun setupBackNavigation() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    "(window.__ccHandleAndroidBack && window.__ccHandleAndroidBack()) || false"
                ) { res ->
                    if (res == "true") return@evaluateJavascript
                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        moveTaskToBack(true)
                    }
                }
            }
        })
    }

    inner class AndroidBridge {

        @JavascriptInterface
        fun getStorageJson(): String {
            return synchronized(this@MainActivity) {
                try {
                    storageFile.readText(Charsets.UTF_8)
                } catch (e: Exception) {
                    "{}"
                }
            }
        }

        @JavascriptInterface
        fun saveStoragePatch(patchJsonStr: String) {
            synchronized(this@MainActivity) {
                try {
                    val current = try {
                        JSONObject(storageFile.readText(Charsets.UTF_8))
                    } catch (e: Exception) {
                        JSONObject()
                    }
                    val patch = JSONObject(patchJsonStr)
                    val keys = patch.keys()
                    while (keys.hasNext()) {
                        val k = keys.next()
                        current.put(k, patch.get(k))
                    }
                    storageFile.writeText(current.toString(), Charsets.UTF_8)
                } catch (e: Exception) {
                    e.printStackTrace()
                }
            }
        }

        @JavascriptInterface
        fun readAssetText(relPath: String): String {
            val clean = relPath.trimStart('/')
            if (clean.startsWith("user_scripts/")) {
                val f = File(userScriptsDir, clean.removePrefix("user_scripts/"))
                if (f.exists()) return f.readText(Charsets.UTF_8)
            }
            return readAssetTextSafe(clean)
        }

        @JavascriptInterface
        fun saveUserScriptFile(fileName: String, codeContent: String): Boolean {
            return try {
                val safeName = fileName.replace(Regex("[^a-zA-Z0-9._-]"), "_")
                val outFile = File(userScriptsDir, safeName)
                outFile.writeText(codeContent, Charsets.UTF_8)
                true
            } catch (e: Exception) {
                false
            }
        }

        @JavascriptInterface
        fun listAvailableScriptsJson(): String {
            val arr = JSONArray()
            try {
                assets.list("scripts")?.forEach { name ->
                    if (name.endsWith(".js")) arr.put(name)
                }
                userScriptsDir.listFiles()?.forEach { f ->
                    if (f.name.endsWith(".js")) arr.put(f.name)
                }
            } catch (e: Exception) {}
            return arr.toString()
        }

        @JavascriptInterface
        fun downloadFile(fileName: String, content: String, isBase64: Boolean) {
            mainHandler.post {
                try {
                    val bytes = if (isBase64) {
                        Base64.decode(content, Base64.DEFAULT)
                    } else {
                        content.toByteArray(Charsets.UTF_8)
                    }

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        val resolver = applicationContext.contentResolver
                        val values = ContentValues().apply {
                            put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                            put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream")
                            put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/ChessCoach")
                        }
                        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                        if (uri != null) {
                            resolver.openOutputStream(uri)?.use { it.write(bytes) }
                            Toast.makeText(
                                this@MainActivity,
                                "💾 Сохранено в Загрузки/ChessCoach/$fileName",
                                Toast.LENGTH_LONG
                            ).show()
                        }
                    } else {
                        val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
                        val outFile = File(dir, fileName)
                        FileOutputStream(outFile).use { it.write(bytes) }
                        Toast.makeText(
                            this@MainActivity,
                            "💾 Сохранено: ${outFile.absolutePath}",
                            Toast.LENGTH_LONG
                        ).show()
                    }
                } catch (e: Exception) {
                    Toast.makeText(
                        this@MainActivity,
                        "Ошибка сохранения: ${e.message}",
                        Toast.LENGTH_SHORT
                    ).show()
                }
            }
        }

        @JavascriptInterface
        fun switchPlatformUrl(targetUrl: String) {
            mainHandler.post {
                webView.loadUrl(targetUrl)
            }
        }

        @JavascriptInterface
        fun vibrateTick(durationMs: Long) {
            try {
                val vib = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vib.vibrate(VibrationEffect.createOneShot(durationMs.coerceIn(5, 100), VibrationEffect.DEFAULT_AMPLITUDE))
                } else {
                    @Suppress("DEPRECATION")
                    vib.vibrate(durationMs.coerceIn(5, 100))
                }
            } catch (e: Exception) {}
        }

        @JavascriptInterface
        fun dispatchNativeTap(cssX: Float, cssY: Float, holdMs: Long) {
            mainHandler.post {
                val density = resources.displayMetrics.density
                val rawX = cssX * density
                val rawY = cssY * density
                val downTime = SystemClock.uptimeMillis()

                val downEvent = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, rawX, rawY, 0)
                webView.dispatchTouchEvent(downEvent)
                downEvent.recycle()

                val safeHold = holdMs.coerceIn(35L, 220L)
                mainHandler.postDelayed({
                    val upTime = SystemClock.uptimeMillis()
                    val upEvent = MotionEvent.obtain(downTime, upTime, MotionEvent.ACTION_UP, rawX + 0.5f, rawY + 0.5f, 0)
                    webView.dispatchTouchEvent(upEvent)
                    upEvent.recycle()
                }, safeHold)
            }
        }
    }
}