package com.bdx.texlab.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.bdx.texlab.data.TestMethod
import com.bdx.texlab.data.UsageQuota
import com.bdx.texlab.ui.DocumentChatState
import com.bdx.texlab.ui.DownloadStatus

/**
 * Details for one method, straight from its Airtable row: method, name, year, scope and the
 * attached PDF, with the View and Download actions.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MethodDetailScreen(
    method: TestMethod?,
    quota: UsageQuota?,
    downloadStatus: DownloadStatus?,
    message: String?,
    onMessageShown: () -> Unit,
    onBack: () -> Unit,
    onView: () -> Unit,
    onDownload: () -> Unit,
    chat: DocumentChatState,
    onAskAi: () -> Unit,
    onDismissChat: () -> Unit,
    onAskDocument: (String) -> Unit,
) {
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(message) {
        val text = message
        if (text != null) {
            snackbarHostState.showSnackbar(text)
            onMessageShown()
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        floatingActionButton = {
            if (method != null) {
                ExtendedFloatingActionButton(
                    onClick = onAskAi,
                    icon = { Icon(Icons.Filled.AutoAwesome, contentDescription = null) },
                    text = { Text("Ask AI") },
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                )
            }
        },
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                title = {
                    Column {
                        Text("Method details", fontWeight = FontWeight.SemiBold)
                        method?.let {
                            Text(
                                text = listOfNotNull(
                                    it.category.takeIf(String::isNotBlank),
                                    it.year.takeIf(String::isNotBlank),
                                ).joinToString(" · ").ifBlank { "Test method" },
                                style = MaterialTheme.typography.labelSmall,
                            )
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = MaterialTheme.colorScheme.onPrimary,
                    navigationIconContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
            )
        },
    ) { padding ->
        if (method == null) {
            Box(
                modifier = Modifier.padding(padding).fillMaxSize().padding(32.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "This method is no longer available. Go back and refresh the library.",
                    style = MaterialTheme.typography.bodyMedium,
                    textAlign = TextAlign.Center,
                )
            }
            return@Scaffold
        }

        Column(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Card(shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier.padding(18.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Surface(
                        color = MaterialTheme.colorScheme.primaryContainer,
                        contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                        shape = RoundedCornerShape(50),
                    ) {
                        Text(
                            text = method.category.ifBlank { "Method" },
                            style = MaterialTheme.typography.labelMedium,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                        )
                    }
                    Text(
                        text = method.title,
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold,
                    )
                    if (method.name.isNotBlank() && method.name != method.title) {
                        Text(
                            text = method.name,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (method.year.isNotBlank()) {
                        Text(
                            text = "Year ${method.year}",
                            style = MaterialTheme.typography.labelLarge,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }

            DetailCard(
                rows = listOf(
                    "Method" to method.title,
                    "Name" to method.name,
                    "Year" to method.year,
                    "Standard" to method.standard,
                    "Code" to method.code,
                    "Standard family" to method.category,
                ).filter { it.second.isNotBlank() }.distinctBy { it.second },
            )

            if (method.summary.isNotBlank()) {
                SectionCard(title = "Scope", body = method.summary)
            }

            SectionCard(
                title = "PDF",
                body = listOfNotNull(
                    method.pdf?.filename?.takeIf { it.isNotBlank() } ?: method.fileName,
                    method.sizeLabel,
                ).joinToString(" · ").ifBlank { "No PDF attached to this method." },
            )

            quota?.let { QuotaCard(quota) }

            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    onClick = onView,
                    enabled = method.hasPdf,
                    modifier = Modifier.weight(1f).heightIn(min = 50.dp),
                ) {
                    Icon(Icons.Filled.Visibility, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("View")
                }
                OutlinedButton(
                    onClick = onDownload,
                    enabled = method.hasPdf && downloadStatus?.inProgress != true,
                    modifier = Modifier.weight(1f).heightIn(min = 50.dp),
                ) {
                    Icon(Icons.Filled.Download, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(if (downloadStatus?.savedPath != null) "Saved" else "Download")
                }
            }

            downloadStatus?.let { status ->
                when {
                    status.inProgress -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        LinearProgressIndicator(
                            progress = { status.progress ?: 0f },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Text(
                            text = "Downloading… ${((status.progress ?: 0f) * 100).toInt()}%",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }

                    status.error != null -> Text(
                        text = status.error,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.error,
                    )

                    status.savedPath != null -> Text(
                        text = "Saved to ${status.savedPath}",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }

            // Leaves room for the Ask AI button floating over the end of the page.
            Spacer(Modifier.height(72.dp))
        }
    }

    if (method != null && chat.methodId == method.id) {
        DocumentChatDialog(
            methodTitle = method.title,
            chat = chat,
            onDismiss = onDismissChat,
            onAsk = onAskDocument,
        )
    }
}

/** Today's allowance, as the proxy counts it (the limits are enforced server-side). */
@Composable
private fun QuotaCard(quota: UsageQuota) {
    val downloads = if (quota.downloadsLimit == 0) {
        "Downloads are not included in the ${quota.level.label} plan."
    } else {
        "${quota.downloadsLeft} of ${quota.downloadsLimit} downloads left today."
    }
    Card(shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = "Today's allowance · ${quota.level.label}",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = "${quota.viewsLeft} of ${quota.viewsLimit} views left today. $downloads",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun DetailCard(rows: List<Pair<String, String>>) {
    if (rows.isEmpty()) return
    Card(shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            rows.forEach { (label, value) ->
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(
                        text = label,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.width(104.dp),
                    )
                    Text(
                        text = value,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

@Composable
private fun SectionCard(title: String, body: String) {
    Card(shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
