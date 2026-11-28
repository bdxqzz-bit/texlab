package com.bdx.texlab.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.bdx.texlab.data.MembershipLevel
import com.bdx.texlab.data.proTimeLeft
import com.bdx.texlab.ui.AppUiState

/**
 * The signed-in member's details, opened by tapping the avatar: Google photo and name, the email
 * the proxy verifies, the Airtable membership level and role, and today's allowance.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MemberDetailsSheet(
    state: AppUiState,
    onDismiss: () -> Unit,
    onTogglePush: (Boolean) -> Unit,
    onSignOut: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState()
    val context = LocalContext.current
    var permissionDenied by remember { mutableStateOf(false) }
    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) onTogglePush(true) else permissionDenied = true
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                MemberAvatar(
                    photoUrl = state.photoUrl,
                    initials = state.firstName ?: state.memberName ?: "M",
                    size = 64.dp,
                )
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(
                        text = state.profileFullName(),
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = state.userEmail ?: "No email on file",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            HorizontalDivider()

            // Pro is time-limited (invitations and approved uploads add days); Basic and Max are
            // not, so only a Pro member sees how long the plan still runs.
            if (state.level == MembershipLevel.PRO) {
                ProMembershipPanel(left = proTimeLeft(state.proUntil))
            }

            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                DetailRow(label = "Email", value = state.userEmail)
                DetailRow(label = "First name", value = state.firstName)
                DetailRow(label = "Last name", value = state.lastName)
                DetailRow(label = "Role", value = state.role)
                DetailRow(label = "Membership", value = levelLine(state))
            }

            state.quota?.let { quota ->
                Surface(
                    shape = RoundedCornerShape(16.dp),
                    color = MaterialTheme.colorScheme.primaryContainer,
                    contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Text(
                            text = "Today's allowance",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            text = "${quota.viewsUsed} of ${quota.viewsLimit} views used",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Text(
                            text = if (quota.downloadsLimit == 0) {
                                "Downloads are not included in the ${quota.level.label} plan"
                            } else {
                                "${quota.downloadsUsed} of ${quota.downloadsLimit} downloads used"
                            },
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }

            HorizontalDivider()

            // The member's own switch: nothing is sent to this device unless it is on.
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(
                    imageVector = Icons.Filled.Notifications,
                    contentDescription = null,
                    modifier = Modifier.size(20.dp),
                )
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(
                        text = "Lab notifications",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = if (state.pushEnabled) {
                            "On — this device receives messages from the lab administrator."
                        } else {
                            "Off — turn on to be told when the lab publishes an update."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(
                    checked = state.pushEnabled,
                    enabled = !state.pushBusy,
                    onCheckedChange = { wanted ->
                        permissionDenied = false
                        val needsPermission = wanted &&
                            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                            ContextCompat.checkSelfPermission(
                                context,
                                Manifest.permission.POST_NOTIFICATIONS,
                            ) != PackageManager.PERMISSION_GRANTED
                        if (needsPermission) {
                            permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                        } else {
                            onTogglePush(wanted)
                        }
                    },
                )
            }

            val pushProblem = state.pushError
                ?: if (permissionDenied) "Android is blocking notifications for TexLab. Allow them in the app's settings." else null
            pushProblem?.let { problem ->
                Text(
                    text = problem,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            OutlinedButton(
                onClick = {
                    onDismiss()
                    onSignOut()
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.Logout,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp),
                )
                Text(text = "Sign out", modifier = Modifier.padding(start = 8.dp))
            }
        }
    }
}

/** Full name from the Members row, falling back to the member name or a neutral label. */
private fun AppUiState.profileFullName(): String =
    listOfNotNull(
        firstName?.trim()?.takeIf { it.isNotEmpty() },
        lastName?.trim()?.takeIf { it.isNotEmpty() },
    ).joinToString(" ")
        .ifBlank { memberName?.trim()?.takeIf { it.isNotEmpty() } ?: "Textile lab member" }

private fun levelLine(state: AppUiState): String? {
    val level = state.level?.label ?: return null
    val role = state.role?.trim()?.takeIf { it.isNotEmpty() && !it.equals("Member", ignoreCase = true) }
    return if (role == null) level else "$level · $role"
}

@Composable
private fun DetailRow(label: String, value: String?) {
    val text = value?.trim()?.takeIf { it.isNotEmpty() } ?: return
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(96.dp),
        )
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f),
        )
    }
}
