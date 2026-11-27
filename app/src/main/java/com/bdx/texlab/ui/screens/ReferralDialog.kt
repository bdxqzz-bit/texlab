package com.bdx.texlab.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.bdx.texlab.ui.ReferralUiState

/**
 * Asked once, right after a brand-new member's first sign-in: a colleague's referral code gives
 * both sides the Pro trial the proxy reports in [ReferralUiState.trialDays]. "Skip" closes it for
 * good — the same field is available later from the menu.
 */
@Composable
fun ReferralDialog(
    state: ReferralUiState,
    onCodeChange: (String) -> Unit,
    onApply: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Have a referral code?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    text = state.trialDays.takeIf { it > 0 }?.let { days ->
                        "Enter a colleague's code and you both get $days days of Pro."
                    } ?: "Enter a colleague's code and you both earn a Pro trial.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = state.code,
                    onValueChange = onCodeChange,
                    label = { Text("Referral code") },
                    placeholder = { Text("ABCD-EFGH") },
                    singleLine = true,
                    enabled = !state.redeeming,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.Characters,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
                state.error?.let { message ->
                    Text(
                        text = message,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = onApply,
                enabled = !state.redeeming && state.code.length >= 8,
            ) {
                Text(if (state.redeeming) "Checking…" else "Apply")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !state.redeeming) { Text("Skip") }
        },
    )
}
