package com.bdx.texlab.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.bdx.texlab.data.MethodUpload

/**
 * One submitted method as an administrator reviews it: the file the member sent, the method name
 * and scope an AI review read out of it, the number of Pro days to grant, and the library table
 * the method is copied into when it is approved.
 *
 * Nothing is written until Approve or Reject is pressed. "Analyse with AI" only asks the proxy to
 * read the document; it already stores what it finds on the uploads row.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MethodUploadSheet(
    upload: MethodUpload,
    methodName: String,
    scope: String,
    standard: String,
    table: String,
    tables: List<String>,
    days: Int,
    publish: Boolean,
    assistant: Boolean,
    analysing: Boolean,
    reviewing: Boolean,
    error: String?,
    onMethodNameChange: (String) -> Unit,
    onScopeChange: (String) -> Unit,
    onTableChange: (String) -> Unit,
    onDaysChange: (Int) -> Unit,
    onPublishChange: (Boolean) -> Unit,
    onAnalyse: () -> Unit,
    onApprove: () -> Unit,
    onReject: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val busy = analysing || reviewing

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = upload.headline,
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = buildString {
                        append(upload.displayName)
                        if (upload.email.isNotBlank()) append(" · ${upload.email}")
                        if (upload.dateLabel.isNotBlank()) append(" · ${upload.dateLabel}")
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = buildString {
                        append(upload.statusLabel)
                        if (upload.fileName.isNotBlank()) append(" · ${upload.fileName}")
                        if (upload.fileLabel.isNotBlank()) append(" (${upload.fileLabel})")
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (upload.rewarded) {
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.primaryContainer,
                    contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = "This upload has already added ${upload.days} days of Pro" +
                            (if (upload.publishedLabel.isNotBlank()) {
                                " and its method is in ${upload.publishedLabel}."
                            } else {
                                "."
                            }),
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }

            HorizontalDivider()

            Text(
                text = "AI review",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = if (assistant) {
                    "Let Gemini read the document and fill in the method name, scope and standard. " +
                        "The result is stored on the upload row, so Airtable shows the same values."
                } else {
                    "AI review is not configured on the server (set the GEMINI_API_KEY secret). " +
                        "Type the method name and scope yourself."
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedButton(
                onClick = onAnalyse,
                enabled = assistant && !busy,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (analysing) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                } else {
                    Icon(
                        imageVector = Icons.Filled.AutoAwesome,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                }
                Text(
                    text = if (analysing) "Reading the document…" else "Analyse with AI",
                    modifier = Modifier.padding(start = 8.dp),
                )
            }

            OutlinedTextField(
                value = methodName,
                onValueChange = onMethodNameChange,
                label = { Text("Method name") },
                placeholder = { Text("e.g. ISO 105-C06") },
                singleLine = true,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = scope,
                onValueChange = onScopeChange,
                label = { Text("Scope of method") },
                placeholder = { Text("What the method covers and which materials it applies to") },
                minLines = 3,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            )
            if (standard.isNotBlank()) {
                Text(
                    text = "Standard detected: $standard",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            HorizontalDivider()

            Text(
                text = "Review",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = "Pro days to add",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Slider(
                    value = days.toFloat(),
                    onValueChange = { onDaysChange(it.toInt()) },
                    valueRange = 1f..30f,
                    steps = 28,
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = "$days d",
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.width(48.dp),
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "Add the method to the library",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        text = "Copies the file, method name and scope into the chosen table.",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(
                    checked = publish,
                    onCheckedChange = onPublishChange,
                    enabled = !busy,
                )
            }

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
                TextButton(onClick = onReject, enabled = !busy && !upload.rewarded) {
                    Text("Reject")
                }
                Button(
                    onClick = onApprove,
                    enabled = !busy && !upload.rewarded,
                    modifier = Modifier.weight(1f),
                ) {
                    if (reviewing) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                    } else {
                        Icon(
                            imageVector = Icons.Filled.Check,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                    Text(
                        text = when {
                            reviewing -> "Saving…"
                            publish -> "Approve & add to library"
                            else -> "Approve $days days"
                        },
                        modifier = Modifier.padding(start = 8.dp),
                    )
                }
            }

            TextButton(onClick = onDismiss, enabled = !busy) { Text("Close") }
        }
    }
}