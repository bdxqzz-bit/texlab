package com.bdx.texlab.ui.screens

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.bdx.texlab.ui.InviteUiState

/**
 * The invitation code section: this member's own code with Copy and Share, and — for a member who
 * has not used one yet — a field for a colleague's code. Redeeming a code gives both sides seven
 * days of Pro; the proxy decides, this screen only shows the result. Used by the corner-menu
 * dialog and inline on the upgrade screen.
 */
@Composable
fun InviteSection(
    state: InviteUiState,
    onCodeChange: (String) -> Unit,
    onRedeem: () -> Unit,
) {
    val info = state.info
    val code = info.code
    val context = LocalContext.current

    fun copyCode() {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        clipboard?.setPrimaryClip(ClipData.newPlainText("TexLab invitation code", code))
        Toast.makeText(context, "Invitation code copied", Toast.LENGTH_SHORT).show()
    }

    fun shareCode() {
        val text = "Join me on TexLab — use my invitation code $code and we both get " +
            "${info.trialDays} days of Pro."
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
        }
        context.startActivity(Intent.createChooser(intent, "Share invitation code"))
    }

    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            text = "Share your code. A member who signs up with it gets ${info.trialDays} " +
                "days of Pro — and so do you.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        when {
            state.loading -> CircularProgressIndicator(modifier = Modifier.padding(8.dp))

            code.isNotBlank() -> {
                Surface(
                    shape = RoundedCornerShape(14.dp),
                    color = MaterialTheme.colorScheme.primaryContainer,
                    contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = code,
                        modifier = Modifier.padding(vertical = 16.dp),
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 3.sp,
                        textAlign = TextAlign.Center,
                    )
                }
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TextButton(onClick = ::copyCode) { Text("Copy") }
                    TextButton(onClick = ::shareCode) { Text("Share") }
                }
            }
        }

        info.proUntilLabel?.let { until ->
            Text(
                text = if (info.redeemed) {
                    "You joined with an invitation code — Pro until $until."
                } else {
                    "Pro until $until from members who joined with your code."
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary,
            )
        }

        if (info.invites > 0) {
            Text(
                text = if (info.invites == 1) {
                    "1 member has joined with your code."
                } else {
                    "${info.invites} members have joined with your code."
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        // One code per member, ever: the field disappears once one has been used.
        if (code.isNotBlank() && !info.redeemed) {
            OutlinedTextField(
                value = state.codeInput,
                onValueChange = onCodeChange,
                label = { Text("Add a friend's code") },
                placeholder = { Text("ABCD-EFGH") },
                singleLine = true,
                enabled = !state.redeeming,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
                modifier = Modifier.fillMaxWidth(),
            )
            Button(
                onClick = onRedeem,
                enabled = !state.redeeming && state.codeInput.length >= 8,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (state.redeeming) "Checking…" else "Apply code")
            }
        }

        state.error?.let { message ->
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

/** The invitation dialog from the home screen's corner menu. */
@Composable
fun InviteDialog(
    state: InviteUiState,
    onCodeChange: (String) -> Unit,
    onRedeem: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Invite a colleague") },
        text = { InviteSection(state = state, onCodeChange = onCodeChange, onRedeem = onRedeem) },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Done") } },
    )
}
