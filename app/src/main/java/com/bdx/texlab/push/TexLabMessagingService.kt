package com.bdx.texlab.push

import com.bdx.texlab.BuildConfig
import com.bdx.texlab.auth.AuthRepository
import com.bdx.texlab.data.AppConfig
import com.bdx.texlab.data.ProxyClient
import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Receives the console's pushes.
 *
 * A refreshed device token is registered with the proxy only while the member is signed in and has
 * left notifications on; the proxy stores it against that member's row, which is how a send finds
 * the device. A message that arrives while the app is in the foreground is drawn here, because FCM
 * only draws notification payloads itself when the app is in the background.
 */
class TexLabMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        if (!PushPrefs.isEnabled(this)) return
        if (FirebaseApp.getApps(this).isEmpty()) return
        if (FirebaseAuth.getInstance().currentUser == null) return

        val context = applicationContext
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            val client = ProxyClient(AppConfig.proxyBaseUrl) { AuthRepository(context).idToken() }
            runCatching { client.registerPushToken(token, BuildConfig.APPLICATION_ID) }
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val title = message.notification?.title ?: message.data["title"].orEmpty()
        val body = message.notification?.body ?: message.data["body"].orEmpty()
        if (title.isBlank() && body.isBlank()) return
        // Kept for the home screen's bell, whether or not the system lets the card be posted.
        NotificationHistory.record(this, title, body)
        PushNotifications.show(this, title, body)
    }
}
