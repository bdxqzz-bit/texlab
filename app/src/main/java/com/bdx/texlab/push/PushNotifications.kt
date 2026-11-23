package com.bdx.texlab.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.bdx.texlab.MainActivity
import com.bdx.texlab.R

/**
 * The member's own choice to receive lab updates.
 *
 * The choice is kept on the device: the proxy is only told when it is on (the device token is
 * registered against the member row) and told to forget it when it is turned off or the member
 * signs out. Nothing is sent unless the member opted in here.
 */
object PushPrefs {

    private const val FILE = "texlab_push"
    private const val KEY_ENABLED = "enabled"

    fun isEnabled(context: Context): Boolean =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, false)

    fun setEnabled(context: Context, enabled: Boolean) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_ENABLED, enabled)
            .apply()
    }
}

/** Draws the notification the admin console sends, and owns its channel. */
object PushNotifications {

    private val channelId: String
        get() = "texlab_updates"

    /** Called from the application so the channel exists before the first message arrives. */
    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            channelId,
            context.getString(R.string.notification_channel_updates_name),
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = context.getString(R.string.notification_channel_updates_description)
        }
        manager.createNotificationChannel(channel)
    }

    /**
     * Posts one notification. Returns false when the member has not allowed notifications, so the
     * caller can decide whether to surface that. Tapping it opens TexLab.
     */
    fun show(context: Context, title: String, body: String): Boolean {
        val allowed = NotificationManagerCompat.from(context).areNotificationsEnabled() &&
            (
                Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                    ContextCompat.checkSelfPermission(
                        context,
                        Manifest.permission.POST_NOTIFICATIONS,
                    ) == PackageManager.PERMISSION_GRANTED
                )
        if (!allowed) return false

        ensureChannel(context)

        val openApp = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val contentIntent = PendingIntent.getActivity(
            context,
            0,
            openApp,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title.ifBlank { context.getString(R.string.app_name) })
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(contentIntent)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()

        return runCatching {
            NotificationManagerCompat.from(context).notify(notificationId(title, body), notification)
            true
        }.getOrDefault(false)
    }

    /** Stable per message, so FCM redelivery replaces the card instead of stacking duplicates. */
    private fun notificationId(title: String, body: String): Int = (title + body).hashCode()
}
