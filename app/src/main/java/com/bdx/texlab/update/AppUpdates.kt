package com.bdx.texlab.update

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * What `GET /api/app/latest` on the proxy says the newest build is.
 *
 * [minSupported] is a remote floor: an install whose own versionCode is below it must update
 * before it can be used again. Raising it on the Worker forces everybody onto [versionCode].
 */
@Serializable
data class AppUpdateInfo(
    val versionCode: Int = 0,
    val versionName: String = "",
    val minSupported: Int = 0,
    val downloadUrl: String = "",
    val notes: String = "",
) {
    /** A newer build this app can actually fetch and install. */
    val usable: Boolean get() = versionCode > 0 && downloadUrl.startsWith("http")
}

/**
 * Reads the public version document from the proxy. No ID token is sent: the route carries only
 * version metadata, so the check works before sign-in and for an expired session.
 */
class AppUpdateChecker(baseUrl: String) {

    private val endpoint = baseUrl.trim().trimEnd('/') + "/api/app/latest"

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /** The newest build the proxy knows about, or null when it cannot be read. */
    suspend fun latest(): AppUpdateInfo? = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder()
                .url(endpoint)
                .header("Accept", "application/json")
                .build()
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@use null
                val body = response.body?.string().orEmpty()
                runCatching { json.decodeFromString<AppUpdateInfo>(body) }
                    .getOrNull()
                    ?.takeIf { it.usable }
            }
        }.getOrNull()
    }
}

/** What happened when the downloaded APK was handed to Android's installer. */
enum class InstallResult {
    /** The package installer is on screen. */
    STARTED,

    /** This app may not install packages yet; the settings screen for that was opened. */
    NEEDS_PERMISSION,

    /** No installer accepted the file. */
    NO_INSTALLER,
}

/**
 * Downloads a published APK and starts Android's package installer.
 *
 * Android does not allow an app to replace itself silently, so the member always confirms the
 * install in the system installer. The APK is stored in the cache under `updates/`, which
 * `res/xml/file_paths.xml` shares through the app's FileProvider.
 */
class ApkInstaller(private val context: Context) {

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    /** Where the build for [info] is kept; Android may clear the cache when storage runs low. */
    fun apkFile(info: AppUpdateInfo): File {
        val directory = File(context.cacheDir, "updates").apply { mkdirs() }
        return File(directory, "texlab-${info.versionCode}.apk")
    }

    /** Streams the APK, reporting 0..1, and returns the stored file (a previous download is reused). */
    suspend fun download(info: AppUpdateInfo, onProgress: (Float) -> Unit = {}): File =
        withContext(Dispatchers.IO) {
            val target = apkFile(info)
            if (target.length() > 0) return@withContext target

            val request = Request.Builder()
                .url(info.downloadUrl)
                .header("Accept", "application/vnd.android.package-archive")
                .build()
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw IOException("The update download failed (HTTP ${response.code}).")
                }
                val body = response.body ?: throw IOException("The update download was empty.")
                val total = body.contentLength()
                val partial = File(target.parentFile, target.name + ".part")
                body.byteStream().use { input ->
                    partial.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var copied = 0L
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            output.write(buffer, 0, read)
                            copied += read
                            if (total > 0) {
                                onProgress((copied.toFloat() / total.toFloat()).coerceIn(0f, 1f))
                            }
                        }
                    }
                }
                if (partial.length() == 0L) {
                    partial.delete()
                    throw IOException("The update download was empty.")
                }
                if (!partial.renameTo(target)) {
                    partial.delete()
                    throw IOException("The update file could not be stored.")
                }
                onProgress(1f)
                target
            }
        }

    /** Starts the system installer for an already downloaded build. */
    fun install(info: AppUpdateInfo): InstallResult {
        val file = apkFile(info)
        if (!file.exists()) return InstallResult.NO_INSTALLER

        if (!context.packageManager.canRequestPackageInstalls()) {
            runCatching {
                context.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${context.packageName}"),
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
            return InstallResult.NEEDS_PERMISSION
        }

        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file,
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try {
            context.startActivity(intent)
            InstallResult.STARTED
        } catch (_: ActivityNotFoundException) {
            InstallResult.NO_INSTALLER
        }
    }
}
