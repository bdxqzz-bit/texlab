package com.bdx.texlab.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/** What the member is writing to the administrator about. */
private enum class ContactKind(val wire: String, val label: String) {
    REPORT("report", "Report a problem"),
    REQUEST("request", "Request"),
}

/**
 * Lets a member report a problem or send a request to the lab administrator. The message is
 * stored by the proxy in the Messages table and read in the admin console inside the app, so no
 * email app or mail account is involved.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactAdminScreen(
    memberEmail: String?,
    onSend: suspend (kind: String, subject: String, message: String) -> Unit,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var kind by remember { mutableStateOf(ContactKind.REPORT) }
    var subject by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var sending by remember { mutableStateOf(false) }
    var sent by remember { mutableStateOf(false) }

    fun submit() {
        if (sent) {
            subject = ""
            message = ""
            sent = false
            error = null
            return
        }
        val text = message.trim()
        if (text.length < 5) {
            error = "Write a short message first."
            return
        }
        error = null
        sending = true
        scope.launch {
            try {
                onSend(kind.wire, subject.trim(), text)
                sent = true
            } catch (failure: Exception) {
                error = failure.message ?: "The message could not be sent. Try again."
            } finally {
                sending = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                title = { Text("Report or request", fontWeight = FontWeight.SemiBold) },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = MaterialTheme.colorScheme.onPrimary,
                    navigationIconContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(
                text = "Message the lab administrator",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = "Report a problem or request access, a method or a feature. The message is " +
                    "delivered inside TexLab and the administrator reads it in the admin console, " +
                    "so you do not need an email app.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                ContactKind.entries.forEach { option ->
                    FilterChip(
                        selected = kind == option,
                        onClick = {
                            kind = option
                            error = null
                        },
                        label = { Text(option.label) },
                    )
                }
            }

            OutlinedTextField(
                value = subject,
                onValueChange = {
                    subject = it.take(120)
                    error = null
                },
                label = { Text("Subject (optional)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value = message,
                onValueChange = {
                    message = it.take(2000)
                    error = null
                },
                label = { Text("Message") },
                minLines = 6,
                modifier = Modifier.fillMaxWidth(),
            )

            memberEmail?.trim()?.takeIf { it.isNotEmpty() }?.let { email ->
                Text(
                    text = "Your message is signed with $email so the administrator can reply.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            error?.let { problem ->
                Text(
                    text = problem,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            if (sent) {
                Card(shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
                    Text(
                        text = "Message sent. The lab administrator can read it in the admin console.",
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(16.dp),
                    )
                }
            }

            Button(
                onClick = ::submit,
                enabled = !sending,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (sending) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                } else {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.Send,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                }
                Spacer(Modifier.width(8.dp))
                Text(
                    when {
                        sending -> "Sending…"
                        sent -> "Send another message"
                        else -> "Send message"
                    },
                )
            }
        }
    }
}
