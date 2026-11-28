package com.bdx.texlab.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.bdx.texlab.data.AdminMember
import com.bdx.texlab.data.AdminRole
import com.bdx.texlab.data.MemberStatus
import com.bdx.texlab.data.MembershipLevel

/**
 * One member as an administrator sees them: the Google profile copied onto their Members row,
 * the account the proxy verifies, today's counters, and the three fields the console may change.
 *
 * Nothing is sent until Save is pressed; only the fields that differ from the saved row are
 * written, so an accidental tap on an already-selected chip is harmless.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun AdminMemberSheet(
    member: AdminMember,
    role: AdminRole,
    level: MembershipLevel,
    status: MemberStatus,
    saving: Boolean,
    error: String?,
    canSave: Boolean,
    onRoleChange: (AdminRole) -> Unit,
    onLevelChange: (MembershipLevel) -> Unit,
    onStatusChange: (MemberStatus) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState()

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
                    photoUrl = member.photoUrl,
                    initials = member.displayName,
                    size = 56.dp,
                )
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Text(
                        text = member.displayName,
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = member.email,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            if (!member.active) {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.errorContainer,
                    contentColor = MaterialTheme.colorScheme.onErrorContainer,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = "This membership is not active (${member.statusLabel}). " +
                            "The member is refused at sign-in until it is set to Active.",
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }

            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                DetailLine(label = "First name", value = member.firstName)
                DetailLine(label = "Last name", value = member.lastName)
                DetailLine(label = "Role", value = member.role)
                DetailLine(label = "Membership", value = member.levelLabel)
                // Only Pro ends on a date; an admin needs that date to know when to renew.
                DetailLine(label = "Pro until", value = member.proUntilSummary)
                DetailLine(label = "Status", value = member.statusLabel)
                DetailLine(
                    label = "Device",
                    value = when {
                        !member.device -> "No device registered"
                        member.registeredAt.isNotBlank() -> "Registered ${member.registeredAt}"
                        else -> "Registered"
                    },
                )
                if (member.viewsLimit > 0 || member.downloadsLimit > 0) {
                    DetailLine(
                        label = "Today",
                        value = buildString {
                            append("${member.viewsUsed} of ${member.viewsLimit} views")
                            append(
                                if (member.downloadsLimit == 0) {
                                    " · no downloads on this plan"
                                } else {
                                    " · ${member.downloadsUsed} of ${member.downloadsLimit} downloads"
                                },
                            )
                        },
                    )
                }
            }

            HorizontalDivider()

            Text(
                text = "Access",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )

            Text(
                text = "Role",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AdminRole.entries.forEach { option ->
                    FilterChip(
                        selected = role == option,
                        enabled = !saving,
                        onClick = { onRoleChange(option) },
                        label = { Text(option.label) },
                    )
                }
            }

            Text(
                text = "Membership",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                MembershipLevel.entries.forEach { option ->
                    FilterChip(
                        selected = level == option,
                        enabled = !saving,
                        onClick = { onLevelChange(option) },
                        label = { Text(option.label) },
                    )
                }
            }

            Text(
                text = "Status",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                MemberStatus.entries.forEach { option ->
                    FilterChip(
                        selected = status == option,
                        enabled = !saving,
                        onClick = { onStatusChange(option) },
                        label = { Text(option.label) },
                    )
                }
            }

            Text(
                text = "Admins can only be demoted or deactivated by another admin; " +
                    "an admin cannot lock themselves out.",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            error?.let { message ->
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(onClick = onDismiss, enabled = !saving) { Text("Close") }
                Button(
                    onClick = onSave,
                    enabled = canSave,
                    modifier = Modifier.weight(1f),
                ) {
                    if (saving) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                    } else {
                        Icon(
                            imageVector = Icons.Filled.Save,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                    Text(
                        text = when {
                            saving -> "Saving…"
                            canSave -> "Save changes"
                            else -> "Saved"
                        },
                        modifier = Modifier.padding(start = 8.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun DetailLine(label: String, value: String?) {
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
