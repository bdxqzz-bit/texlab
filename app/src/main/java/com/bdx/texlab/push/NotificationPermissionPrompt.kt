package com.bdx.texlab.push

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.bdx.texlab.R

/** Whether Android currently lets TexLab post notifications. */
internal fun Context.notificationsGranted(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
    return ContextCompat.checkSelfPermission(
        this,
        Manifest.permission.POST_NOTIFICATIONS,
    ) == PackageManager.PERMISSION_GRANTED
}

/** Android 13+ notification settings for this app, where a blocked member can allow them again. */
private fun Context.openNotificationSettings() {
    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { startActivity(intent) }
}

/**
 * Asked on the first open and again on every open while TexLab still may not post notifications.
 *
 * "Allow" shows the system dialog while Android still lets the app ask; once the member has blocked
 * it for good, the same button opens the app's notification settings instead of doing nothing.
 * "Not now" only dismisses this launch, because the next open asks again.
 */
@Composable
fun NotificationPermissionPrompt() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return

    val context = LocalContext.current
    val activity = context as? android.app.Activity
    var granted by remember { mutableStateOf(context.notificationsGranted()) }
    var dismissed by rememberSaveable { mutableStateOf(false) }

    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { allowed -> granted = allowed }

    // Coming back from the system settings is another chance to be allowed.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) granted = context.notificationsGranted()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    if (granted || dismissed) return

    AlertDialog(
        onDismissRequest = { dismissed = true },
        icon = { Icon(Icons.Filled.Notifications, contentDescription = null) },
        title = { Text(stringResource(R.string.notification_permission_title)) },
        text = { Text(stringResource(R.string.notification_permission_body)) },
        confirmButton = {
            TextButton(
                onClick = {
                    dismissed = true
                    val canAsk = !PushPrefs.wasAsked(context) ||
                        (activity != null && ActivityCompat.shouldShowRequestPermissionRationale(
                            activity,
                            Manifest.permission.POST_NOTIFICATIONS,
                        ))
                    PushPrefs.markAsked(context)
                    if (canAsk) launcher.launch(Manifest.permission.POST_NOTIFICATIONS) else context.openNotificationSettings()
                },
            ) {
                Text(stringResource(R.string.notification_permission_allow))
            }
        },
        dismissButton = {
            TextButton(onClick = { dismissed = true }) {
                Text(stringResource(R.string.notification_permission_later))
            }
        },
    )
}
