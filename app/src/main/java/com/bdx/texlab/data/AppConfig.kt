package com.bdx.texlab.data

import android.content.Context
import com.bdx.texlab.BuildConfig
import com.google.firebase.FirebaseApp

/**
 * Runtime configuration.
 *
 * Firebase values are supplied by `app/google-services.json`: the google-services Gradle plugin
 * turns it into resources (`google_app_id`, `google_api_key`, `default_web_client_id`) that the
 * Firebase SDK reads by itself.
 *
 * The app has no Airtable credentials. It only knows the base URL of the lab's proxy server
 * (`PROXY_BASE_URL`), which holds the Airtable token, verifies the Firebase ID token of every
 * request and enforces the member list. See the proxy section of README.md.
 */
object AppConfig {

    private var appContext: Context? = null

    /** Proxy server base URL, e.g. `https://methods.example.org`. */
    val proxyBaseUrl: String = BuildConfig.PROXY_BASE_URL.trim().trimEnd('/')

    /** Shown on the sign-in screen when a Google account is not on the member list. */
    val supportEmail: String = BuildConfig.SUPPORT_EMAIL

    /** Called once from [com.bdx.texlab.TexLabApplication]. */
    fun init(context: Context) {
        val application = context.applicationContext
        appContext = application
        // Normally created by the google-services plugin's init provider; this keeps it correct
        // if the provider did not run.
        FirebaseApp.initializeApp(application)
    }

    private fun generatedString(name: String): String {
        val context = appContext ?: return ""
        val id = context.resources.getIdentifier(name, "string", context.packageName)
        if (id == 0) return ""
        return runCatching { context.getString(id) }.getOrDefault("")
    }

    /**
     * Web OAuth client id used as the `serverClientId` by Credential Manager.
     *
     * Comes from the web client in `google-services.json` (Firebase adds it once the Google
     * provider is enabled). `GOOGLE_WEB_CLIENT_ID` in local.properties overrides it.
     */
    val googleWebClientId: String
        get() = generatedString("default_web_client_id")
            .ifBlank { BuildConfig.GOOGLE_WEB_CLIENT_ID }
            .trim()

    private val firebaseInitialized: Boolean
        get() = appContext?.let { FirebaseApp.getApps(it).isNotEmpty() } == true

    val firebaseReady: Boolean
        get() = firebaseInitialized &&
            googleWebClientId.endsWith(".apps.googleusercontent.com", ignoreCase = true)

    val proxyReady: Boolean
        get() = proxyBaseUrl.startsWith("https://") || proxyBaseUrl.startsWith("http://")

    /** Human readable configuration gaps, empty when the app can run. */
    val setupProblems: List<String>
        get() = buildList {
            if (!firebaseInitialized) {
                add(
                    "Firebase did not start. app/google-services.json must belong to the " +
                        "application id ${BuildConfig.APPLICATION_ID}."
                )
            } else if (!firebaseReady) {
                add(
                    "Google sign-in is not enabled for this Firebase project. In the Firebase " +
                        "console open Authentication -> Sign-in method -> Google, enable it, then " +
                        "download google-services.json again and replace app/google-services.json. " +
                        "That file must contain a web OAuth client so the app can request an ID token."
                )
            }
            if (!proxyReady) {
                add(
                    "The method server is not configured. Set PROXY_BASE_URL in local.properties " +
                        "(for the emulator, http://10.0.2.2:8080 reaches a server on your computer) " +
                        "and use the same Firebase project id there. See README.md, section 3."
                )
            }
        }
}
