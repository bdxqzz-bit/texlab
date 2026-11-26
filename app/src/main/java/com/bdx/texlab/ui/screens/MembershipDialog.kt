package com.bdx.texlab.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.bdx.texlab.data.MembershipLevel
import com.bdx.texlab.ui.AppUiState

/**
 * The card behind the home header's membership badge: today's plan, what it allows today, and the
 * way up — the upgrade screen, which holds the invitation code and the method-upload form.
 */
@Composable
fun MembershipDialog(
    state: AppUiState,
    onUpgrade: () -> Unit,
    onDismiss: () -> Unit,
) {
    val level = state.level ?: MembershipLevel.BASIC
    val quota = state.quota
    val trialDays = state.invite.info.trialDays.takeIf { it > 0 } ?: 7

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Membership") },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
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
                            text = "CURRENT PLAN",
                            style = MaterialTheme.typography.labelSmall,
                        )
                        Text(
                            text = "${level.label} member",
                            style = MaterialTheme.typography.headlineSmall,
                            fontWeight = FontWeight.Bold,
                        )
                        Text(
                            text = when (level) {
                                MembershipLevel.BASIC ->
                                    "The starter plan: a few views, downloads and AI questions each day."
                                MembershipLevel.PRO ->
                                    "More views, downloads and AI questions every day."
                                MembershipLevel.MAX ->
                                    "The lab's highest daily allowance."
                            },
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }

                if (quota != null) {
                    Text(
                        text = "Today: ${quota.viewsLeft} of ${quota.viewsLimit} views · " +
                            "${quota.downloadsLeft} of ${quota.downloadsLimit} downloads · " +
                            "${quota.asksLeft} of ${quota.asksLimit} AI questions",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                state.invite.info.proUntilLabel?.let { until ->
                    Text(
                        text = "Pro is active until $until.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }

                Button(onClick = onUpgrade, modifier = Modifier.fillMaxWidth()) {
                    Text("Upgrade")
                }

                Text(
                    text = "Invite to upgrade — share your code and you both get $trialDays days " +
                        "of Pro.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(onClickLabel = "Open upgrade and invitation") { onUpgrade() }
                        .padding(vertical = 4.dp),
                )
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}
