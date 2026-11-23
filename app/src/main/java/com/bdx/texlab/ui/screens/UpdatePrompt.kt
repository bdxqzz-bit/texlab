package com.bdx.texlab.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.bdx.texlab.BuildConfig
import com.bdx.texlab.ui.UpdateUiState

/**
 * Flexible update: the member may carry on with the current build and install later.
 */
@Composable
fun UpdateDialog(
    update: UpdateUiState,
    onUpdate: () -> Unit,
    onLater: () -> Unit,
) {
    val info = update.info ?: return
    AlertDialog(
        onDismissRequest = { if (!update.downloading) onLater() },
        icon = { Icon(Icons.Filled.SystemUpdate, contentDescription = null) },
        title = { Text("Update available") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "TexLab ${info.versionName} is available. " +
                        "This build is ${BuildConfig.VERSION_NAME}.",
                )
                if (info.notes.isNotBlank()) Text(info.notes)
                if (update.downloading) {
                    LinearProgressIndicator(
                        progress = { update.progress ?: 0f },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                update.error?.let { message ->
                    Text(message, color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onUpdate, enabled = !update.downloading) {
                Text(
                    when {
                        update.downloaded -> "Install"
                        update.downloading -> "Downloading…"
                        else -> "Update now"
                    },
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onLater, enabled = !update.downloading) {
                Text("Later")
            }
        },
    )
}

/**
 * Forced update: the proxy's `minSupported` is above this build, so the app stays on this screen
 * until the new APK is installed. Back is blocked and there is no dismiss action.
 */
@Composable
fun ForcedUpdateScreen(
    update: UpdateUiState,
    onUpdate: () -> Unit,
) {
    val info = update.info ?: return
    BackHandler(enabled = true) {}
    Surface(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(32.dp),
            verticalArrangement = Arrangement.Center,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Icon(
                Icons.Filled.SystemUpdate,
                contentDescription = null,
                modifier = Modifier.size(56.dp),
                tint = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.height(16.dp))
            Text("Update required", style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.height(8.dp))
            Text(
                "TexLab ${info.versionName} is required to keep using the lab library. " +
                    "This build is ${BuildConfig.VERSION_NAME}.",
                textAlign = TextAlign.Center,
            )
            if (info.notes.isNotBlank()) {
                Spacer(Modifier.height(12.dp))
                Text(info.notes, textAlign = TextAlign.Center)
            }
            if (update.downloading) {
                Spacer(Modifier.height(24.dp))
                LinearProgressIndicator(
                    progress = { update.progress ?: 0f },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            update.error?.let { message ->
                Spacer(Modifier.height(16.dp))
                Text(
                    message,
                    color = MaterialTheme.colorScheme.error,
                    textAlign = TextAlign.Center,
                )
            }
            Spacer(Modifier.height(24.dp))
            Button(
                onClick = onUpdate,
                enabled = !update.downloading,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    when {
                        update.downloaded -> "Install update"
                        update.downloading -> "Downloading…"
                        else -> "Update now"
                    },
                )
            }
            Spacer(Modifier.height(12.dp))
            Text(
                "The update installs over this copy, so your sign-in and settings stay.",
                style = MaterialTheme.typography.bodySmall,
                textAlign = TextAlign.Center,
            )
        }
    }
}
