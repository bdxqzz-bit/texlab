package com.bdx.texlab.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Campaign
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.bdx.texlab.data.AdminMember
import com.bdx.texlab.data.AdminTarget
import com.bdx.texlab.data.MemberMessage
import com.bdx.texlab.data.MembershipLevel
import com.bdx.texlab.ui.AdminUiState
import com.bdx.texlab.ui.AppUiState

/**
 * Admin-only notification console, opened from the home screen. The entry point is hidden for
 * every member role, and the proxy re-checks the role on each request, so this screen is only a
 * convenience on top of the server's gate.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AdminConsoleScreen(
    state: AppUiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onToggleMember: (String) -> Unit,
    onSelectReachable: () -> Unit,
    onClearSelection: () -> Unit,
    onTitleChange: (String) -> Unit,
    onBodyChange: (String) -> Unit,
    onTargetChange: (AdminTarget) -> Unit,
    onLevelChange: (MembershipLevel) -> Unit,
    onSend: () -> Unit,
    onOpenMember: (String) -> Unit,
) {
    if (!state.isAdmin) {
        // Never render the console for a member role, even if the route is somehow reached.
        Surface(modifier = Modifier.fillMaxSize()) {
            Column(
                modifier = Modifier.fillMaxSize().padding(24.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("Not available", style = MaterialTheme.typography.titleMedium)
                Text(
                    text = "Only an administrator can send notifications.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(12.dp))
                TextButton(onClick = onBack) { Text("Go back") }
            }
        }
        return
    }

    val admin = state.admin

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Notification console") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    IconButton(onClick = onRefresh) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Reload members")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = MaterialTheme.colorScheme.onPrimary,
                    navigationIconContentColor = MaterialTheme.colorScheme.onPrimary,
                    actionIconContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
            )
        },
        bottomBar = {
            Surface(tonalElevation = 3.dp) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text = audienceLine(admin),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Button(
                        onClick = onSend,
                        enabled = admin.canSend,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        if (admin.sending) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(18.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onPrimary,
                            )
                            Spacer(Modifier.size(10.dp))
                        } else {
                            Icon(Icons.Filled.Campaign, contentDescription = null)
                            Spacer(Modifier.size(10.dp))
                        }
                        Text(if (admin.sending) "Sending…" else "Send notification")
                    }
                }
            }
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize(),
            contentPadding = PaddingValues(
                start = 16.dp,
                end = 16.dp,
                top = 16.dp,
                bottom = 16.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (admin.loading) {
                item { LinearProgressIndicator(modifier = Modifier.fillMaxWidth()) }
            }

            admin.error?.let { message ->
                item {
                    Card(shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text(
                                text = message,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                            )
                            TextButton(onClick = onRefresh) { Text("Reload members") }
                        }
                    }
                }
            }

            admin.result?.let { result ->
                item {
                    Card(
                        shape = RoundedCornerShape(16.dp),
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Text(
                                text = if (result.failed > 0) "Sent with errors" else "Notification sent",
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Text(
                                text = result.summary,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            result.failures.forEach { (email, reason) ->
                                Text(
                                    text = "$email — $reason",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.error,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                }
            }

            item {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(
                        text = "Member messages",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = if (admin.messages.isEmpty()) {
                            "Reports and requests members send from the app appear here."
                        } else {
                            "${admin.messages.size} sent from inside the app · newest first · " +
                                "reply by email and close the row in Airtable"
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    TextButton(onClick = onRefresh) { Text("Reload messages") }
                }
            }

            if (admin.messagesLoading) {
                item { LinearProgressIndicator(modifier = Modifier.fillMaxWidth()) }
            }

            admin.messagesError?.let { problem ->
                item {
                    Text(
                        text = problem,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }

            if (admin.messages.isEmpty() && !admin.messagesLoading && admin.messagesError == null) {
                item {
                    Text(
                        text = "No member has sent a report or request yet.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            items(
                admin.messages,
                key = { message -> "message-" + message.id.ifBlank { message.email + message.createdAt } },
            ) { message ->
                MessageCard(message)
            }

            item { ComposerCard(admin, onTitleChange, onBodyChange, onTargetChange, onLevelChange) }

            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "Members",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            text = "${admin.members.size} members · " +
                                "${admin.members.count { it.device }} with a device · " +
                                "tap a member to change their access",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = onSelectReachable) { Text("Select all with a device") }
                    TextButton(onClick = onClearSelection) { Text("Clear") }
                }
            }

            if (admin.members.isEmpty() && !admin.loading) {
                item {
                    Text(
                        text = "No members came back from the server.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            items(admin.members, key = { member -> member.id.ifBlank { member.email } }) { member ->
                MemberRow(
                    member = member,
                    selected = member.email in admin.selected,
                    selectable = admin.target == AdminTarget.SELECTED,
                    onToggle = { onToggleMember(member.email) },
                    onOpen = { onOpenMember(member.id.ifBlank { member.email }) },
                )
            }
        }
    }
}

@Composable
private fun MessageCard(message: MemberMessage) {
    Card(shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Surface(
                    shape = RoundedCornerShape(6.dp),
                    color = if (message.isRequest) {
                        MaterialTheme.colorScheme.secondaryContainer
                    } else {
                        MaterialTheme.colorScheme.tertiaryContainer
                    },
                    contentColor = if (message.isRequest) {
                        MaterialTheme.colorScheme.onSecondaryContainer
                    } else {
                        MaterialTheme.colorScheme.onTertiaryContainer
                    },
                ) {
                    Text(
                        text = message.kindLabel,
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                    )
                }
                if (message.dateLabel.isNotBlank()) {
                    Text(
                        text = message.dateLabel,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Text(
                text = message.headline,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Text(text = message.message, style = MaterialTheme.typography.bodyMedium)
            Text(
                text = buildString {
                    append(message.displayName)
                    if (message.email.isNotBlank()) append(" · ${message.email}")
                    if (message.appVersion.isNotBlank()) append(" · v${message.appVersion}")
                },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun ComposerCard(
    admin: AdminUiState,
    onTitleChange: (String) -> Unit,
    onBodyChange: (String) -> Unit,
    onTargetChange: (AdminTarget) -> Unit,
    onLevelChange: (MembershipLevel) -> Unit,
) {
    Card(shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedTextField(
                value = admin.title,
                onValueChange = onTitleChange,
                label = { Text("Title") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            OutlinedTextField(
                value = admin.body,
                onValueChange = onBodyChange,
                label = { Text("Message") },
                minLines = 3,
                modifier = Modifier.fillMaxWidth(),
            )

            Text(
                text = "Send to",
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AdminTarget.entries.forEach { target ->
                    FilterChip(
                        selected = admin.target == target,
                        onClick = { onTargetChange(target) },
                        label = { Text(target.label) },
                    )
                }
            }

            if (admin.target == AdminTarget.LEVEL) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    MembershipLevel.entries.forEach { level ->
                        FilterChip(
                            selected = admin.level == level,
                            onClick = { onLevelChange(level) },
                            label = { Text(level.label) },
                        )
                    }
                }
            }

            if (admin.target != AdminTarget.SELECTED) {
                Text(
                    text = "Tick boxes below only apply to “Selected”.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun MemberRow(
    member: AdminMember,
    selected: Boolean,
    selectable: Boolean,
    onToggle: () -> Unit,
    onOpen: () -> Unit,
) {
    val activeColor = if (isSystemInDarkTheme()) Color(0xFF81C784) else Color(0xFF2E7D32)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onOpen)
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Checkbox(
            checked = selected,
            onCheckedChange = { onToggle() },
            enabled = selectable,
        )
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = member.displayName,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = member.email,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            // Presence: a green dot while the member is using the app, otherwise when they were
            // last seen (the Worker records it on each member request). A member who never has
            // been gets no line at all.
            member.lastSeenLabel?.let { label ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    if (member.online) {
                        Box(
                            modifier = Modifier
                                .size(8.dp)
                                .background(activeColor, CircleShape),
                        )
                    }
                    Text(
                        text = label,
                        style = MaterialTheme.typography.labelSmall,
                        color = if (member.online) activeColor else MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(
                text = member.levelLabel,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
            )
            Text(
                text = buildString {
                    append(member.role)
                    if (member.device) append(" · device")
                    if (!member.active) append(" · ${member.statusLabel}")
                },
                style = MaterialTheme.typography.labelSmall,
                color = if (member.active) {
                    MaterialTheme.colorScheme.onSurfaceVariant
                } else {
                    MaterialTheme.colorScheme.error
                },
                maxLines = 1,
            )
        }
        Icon(
            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = "Open ${member.displayName}",
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(20.dp),
        )
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
}

private fun audienceLine(admin: AdminUiState): String {
    val audience = admin.audience.size
    return when {
        audience == 0 -> "No recipient matched this target yet."
        admin.reachable == 0 -> "$audience selected, but none has a device registered."
        else -> "${admin.reachable} of $audience will receive this on their device."
    }
}
