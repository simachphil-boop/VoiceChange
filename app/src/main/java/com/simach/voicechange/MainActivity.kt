package com.simach.voicechange

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.webkit.WebViewAssetLoader
import java.io.File

class MainActivity : Activity() {

    private lateinit var web: WebView
    private var pendingRequest: PermissionRequest? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    companion object {
        private const val REQ_MIC = 1
        private const val REQ_FILE = 2
        private const val START_URL = "https://appassets.androidplatform.net/assets/www/index.html"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        web = WebView(this)
        web.setBackgroundColor(0xFF0E0B1A.toInt())
        setContentView(web)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? = loader.shouldInterceptRequest(request.url)
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    if (request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                            request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                        } else {
                            pendingRequest = request
                            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC)
                        }
                    } else {
                        request.deny()
                    }
                }
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = filePathCallback
                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "audio/*"
                }
                return try {
                    startActivityForResult(Intent.createChooser(intent, "Выбери запись"), REQ_FILE)
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }

        web.addJavascriptInterface(Bridge(), "AndroidBridge")
        web.loadUrl(START_URL)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_MIC) {
            val req = pendingRequest
            pendingRequest = null
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                req?.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
            } else {
                req?.deny()
                Toast.makeText(this, "Без доступа к микрофону запись не работает", Toast.LENGTH_LONG).show()
            }
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_FILE) {
            val uri = data?.data
            fileCallback?.onReceiveValue(if (resultCode == RESULT_OK && uri != null) arrayOf(uri) else null)
            fileCallback = null
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("window.onAndroidBack ? window.onAndroidBack() : false") { res ->
            if (res != "true") {
                @Suppress("DEPRECATION")
                super.onBackPressed()
            }
        }
    }

    override fun onPause() {
        super.onPause()
        web.evaluateJavascript("window.onAndroidPause && window.onAndroidPause()", null)
    }

    inner class Bridge {
        @JavascriptInterface
        fun saveFile(name: String, base64: String, mime: String): String {
            return try {
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                val where: String
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val values = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                        put(MediaStore.MediaColumns.MIME_TYPE, mime)
                        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/VoiceChange")
                    }
                    val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                        ?: throw IllegalStateException("no uri")
                    contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                    where = "Загрузки/VoiceChange"
                } else {
                    val dir = File(getExternalFilesDir(Environment.DIRECTORY_MUSIC), "VoiceChange")
                    dir.mkdirs()
                    File(dir, name).writeBytes(bytes)
                    where = dir.absolutePath
                }
                runOnUiThread { Toast.makeText(this@MainActivity, "Сохранено: $where/$name", Toast.LENGTH_LONG).show() }
                "ok"
            } catch (e: Exception) {
                runOnUiThread { Toast.makeText(this@MainActivity, "Не удалось сохранить: ${e.message}", Toast.LENGTH_LONG).show() }
                "error"
            }
        }

        @JavascriptInterface
        fun shareFile(name: String, base64: String, mime: String): String {
            return try {
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                val dir = File(cacheDir, "share")
                dir.mkdirs()
                val file = File(dir, name)
                file.writeBytes(bytes)
                val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.files", file)
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = mime
                    putExtra(Intent.EXTRA_STREAM, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                runOnUiThread { startActivity(Intent.createChooser(send, "Поделиться")) }
                "ok"
            } catch (e: Exception) {
                runOnUiThread { Toast.makeText(this@MainActivity, "Не удалось поделиться: ${e.message}", Toast.LENGTH_LONG).show() }
                "error"
            }
        }

        @JavascriptInterface
        fun toast(text: String) {
            runOnUiThread { Toast.makeText(this@MainActivity, text, Toast.LENGTH_SHORT).show() }
        }
    }
}
