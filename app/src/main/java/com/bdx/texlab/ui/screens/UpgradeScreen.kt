package com.bdx.texlab.ui.screens

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.UploadFile
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.bdx.texlab.data.MembershipLevel
import com.bdx.texlab.ui.AppUiState
import com.bdx.texlab.ui.UploadUiState

/** What the file picker offers: the same types the uploads table accepts. */
private val UPLOAD_MIME_TYPES = arrayOf(
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "image/*",
)

/**
 * The upgrade screen opened from the membership badge: the current plan, the invitation code that
 * gives both members Pro, and the method-upload form that earns 1–30 days of Pro on approval.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UpgradeScreen(
    state: AppUiState,
    onBack: () -> Unit,
    onCodeChange: (String) -> Unit,
    onRedeem: () -> Unit,
    onUploadTitleChange: (String) -> Unit,
    onSelectFile: (Uri) -> Unit,
    onClearFile: () -> Unit,
    onSubmitUpload: () -> Unit,
) {
    val level = state.level ?: MembershipLevel.BASIC
    val upload = state.upload
    val pickFile = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri -> uri?.let(onSelectFile) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Upgrade") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Card(shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier.padding(18.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = "Current plan",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        text = "${level.label} member",
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    val quota = state.quota
                    Text(
                        text = if (quota != null) {
                            "Today: ${quota.viewsLeft} of ${quota.viewsLimit} views · " +
                                "${quota.downloadsLeft} of ${quota.downloadsLimit} downloads · " +
                                "${quota.asksLeft} of ${quota.asksLimit} AI questions"
                        } else {
                            "There are two ways to raise your plan: invite a colleague, or send a " +
                                "textile testing method for review."
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Card(shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier.padding(18.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        text = "Invite to upgrade",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    InviteSection(
                        state = state.invite,
                        onCodeChange = onCodeChange,
                        onRedeem = onRedeem,
                    )
                }
            }

            Card(shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier.padding(18.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        text = "Upload a method",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = "Upload a textile testing lab related method/document to get 1 to " +
                            "30 days pro plan.",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        text = "An administrator reviews each upload and adds between 1 and 30 " +
                            "days of Pro to your plan.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )

                    UploadForm(
                        upload = upload,
                        onTitleChange = onUploadTitleChange,
                        onPickFile = { pickFile.launch(UPLOAD_MIME_TYPES) },
                        onClearFile = onClearFile,
                        onSubmit = onSubmitUpload,
                    )
                }
            }
        }
    }
}

@Composable
private fun UploadForm(
    upload: UploadUiState,
    onTitleChange: (String) -> Unit,
    onPickFile: () -> Unit,
    onClearFile: () -> Unit,
    onSubmit: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        OutlinedTextField(
            value = upload.title,
            onValueChange = onTitleChange,
            label = { Text("Method or document title") },
            placeholder = { Text("e.g. ISO 105-C06 colour fastness to washing") },
            singleLine = true,
            enabled = !upload.submitting,
            modifier = Modifier.fillMaxWidth(),
        )

        if (upload.uri == null) {
            OutlinedButton(
                onClick = onPickFile,
                enabled = !upload.submitting,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Filled.UploadFile, contentDescription = null)
                Text("Choose file", modifier = Modifier.padding(start = 8.dp))
            }
        } else {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = upload.fileName,
                        style = MaterialTheme.typography.bodyMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    upload.sizeLabel?.let { size ->
                        Text(
                            text = size,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                TextButton(onClick = onClearFile, enabled = !upload.submitting) { Text("Change") }
            }
        }

        Button(
            onClick = onSubmit,
            enabled = upload.canSubmit,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (upload.submitting) "Uploading…" else "Upload for review")
        }

        upload.error?.let { message ->
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        upload.success?.let { message ->
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}
