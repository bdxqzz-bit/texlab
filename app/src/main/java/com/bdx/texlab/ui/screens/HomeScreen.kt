package com.bdx.texlab.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.AdminPanelSettings
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.bdx.texlab.ui.AppUiState

/** Standard families the library is split into; each is an Airtable table. */
internal val STANDARD_FAMILIES = listOf(
    "ISO" to "International Organization for Standardization",
    "AATCC" to "American Association of Textile Chemists and Colorists",
)

/**
 * Landing screen after sign-in: one card per standard family, with the number of methods the
 * member can open.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    state: AppUiState,
    onOpenCategory: (String) -> Unit,
    onRefresh: () -> Unit,
    onTogglePush: (Boolean) -> Unit,
    onOpenAdmin: () -> Unit,
    onOpenNotifications: () -> Unit,
    unseenNotifications: Int,
    onSignOut: () -> Unit,
) {
    var showDetails by remember { mutableStateOf(false) }

    if (showDetails) {
        MemberDetailsSheet(
            state = state,
            onDismiss = { showDetails = false },
            onTogglePush = onTogglePush,
            onSignOut = onSignOut,
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        MemberAvatar(
                            photoUrl = state.photoUrl,
                            initials = state.firstName ?: state.memberName ?: "M",
                            modifier = Modifier.clickable(onClickLabel = "Show my details") {
                                showDetails = true
                            },
                            fallbackColor = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.22f),
                            fallbackContentColor = MaterialTheme.colorScheme.onPrimary,
                        )
                        Column {
                            Text(
                                text = state.firstName?.let { "Hi, $it" } ?: "TexLab",
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                text = buildString {
                                    append(state.level?.label ?: "Basic")
                                    append(" member")
                                    state.role
                                        ?.takeIf { it.isNotBlank() && !it.equals("Member", true) }
                                        ?.let { append(" · ").append(it) }
                                },
                                style = MaterialTheme.typography.labelSmall,
                            )
                        }
                    }
                },
                actions = {
                    // Only an admin role gets the console entry point; members never see it.
                    if (state.isAdmin) {
                        IconButton(onClick = onOpenAdmin) {
                            Icon(Icons.Filled.AdminPanelSettings, contentDescription = "Admin console")
                        }
                    }
                    IconButton(onClick = onRefresh) {
                        Icon(Icons.Filled.Refresh, contentDescription = "Refresh methods")
                    }
                    IconButton(onClick = onSignOut) {
                        Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = "Sign out")
                    }
                    // Notification history: the corner bell, with a badge for messages not yet read.
                    IconButton(onClick = onOpenNotifications) {
                        BadgedBox(
                            badge = {
                                if (unseenNotifications > 0) {
                                    Badge {
                                        Text(
                                            text = if (unseenNotifications > 9) "9+" else "$unseenNotifications",
                                        )
                                    }
                                }
                            },
                        ) {
                            Icon(Icons.Filled.Notifications, contentDescription = "Notification history")
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = MaterialTheme.colorScheme.onPrimary,
                    actionIconContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
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
            if (state.loadingMethods) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }

            Text(
                text = "Method library",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = "Choose a standard family to browse its test methods.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            state.methodsError?.let { error ->
                ErrorCard(message = error, onRetry = onRefresh)
            }

            STANDARD_FAMILIES.forEach { (family, organisation) ->
                FamilyCard(
                    family = family,
                    organisation = organisation,
                    count = state.countIn(family),
                    loading = state.loadingMethods && state.methods.isEmpty(),
                    onClick = { onOpenCategory(family) },
                )
            }

            Spacer(Modifier.height(4.dp))
            Text(
                text = "Signed in as ${state.userEmail ?: state.memberName ?: "member"}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun FamilyCard(
    family: String,
    organisation: String,
    count: Int,
    loading: Boolean,
    onClick: () -> Unit,
) {
    Card(
        shape = RoundedCornerShape(20.dp),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    ) {
        Row(
            modifier = Modifier.padding(18.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Surface(
                shape = RoundedCornerShape(14.dp),
                color = MaterialTheme.colorScheme.primaryContainer,
                contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                modifier = Modifier.size(56.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(family, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                }
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = family,
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = organisation,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    text = if (loading) "Loading methods…" else "$count ${if (count == 1) "method" else "methods"}",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            Icon(
                imageVector = Icons.Filled.ChevronRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.width(0.dp))
        }
    }
}

@Composable
private fun ErrorCard(message: String, onRetry: () -> Unit) {
    Card(shape = RoundedCornerShape(16.dp), modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = "Could not load the library",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Start,
            )
            androidx.compose.material3.TextButton(onClick = onRetry) { Text("Retry") }
        }
    }
}
