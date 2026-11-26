package com.bdx.texlab.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Login
import androidx.compose.material.icons.filled.Science
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.bdx.texlab.data.AppConfig
import com.bdx.texlab.ui.AppUiState

/**
 * Sign-in and join screen. The library is never composed until the server has confirmed an
 * active membership: a first-time Google account is joined as a Basic member, an inactive
 * (Pending/Revoked) one stays locked out.
 */
@Composable
fun SignInScreen(
    state: AppUiState,
    onSignIn: () -> Unit,
    onInviteCodeChange: (String) -> Unit,
    onRetryMembership: () -> Unit,
    onSignOut: () -> Unit,
) {
    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Surface(
                shape = CircleShape,
                color = MaterialTheme.colorScheme.primaryContainer,
                modifier = Modifier.size(84.dp),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        imageVector = Icons.Filled.Science,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                        modifier = Modifier.size(40.dp),
                    )
                }
            }
            Spacer(Modifier.height(20.dp))
            Text(
                text = "TexLab",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                text = "Standard test methods and PDFs. Join with your Google account to read the library.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )

            Spacer(Modifier.height(32.dp))

            when (state.phase) {
                AppUiState.Phase.CheckingMembership -> CheckingCard(
                    email = state.userEmail,
                    onSignOut = onSignOut,
                )

                AppUiState.Phase.NotAMember -> NotAMemberCard(
                    email = state.deniedEmail,
                    signingIn = state.signingIn,
                    error = state.authError,
                    onTryAgain = onSignIn,
                    onSignOut = onSignOut,
                )

                AppUiState.Phase.MembershipError -> MembershipErrorCard(
                    message = state.membershipError,
                    onRetry = onRetryMembership,
                    onSignOut = onSignOut,
                )

                else -> SignInCard(
                    signingIn = state.signingIn,
                    error = state.authError,
                    inviteCode = state.pendingInviteCode,
                    onInviteCodeChange = onInviteCodeChange,
                    onSignIn = onSignIn,
                )
            }

            Spacer(Modifier.height(28.dp))
            Text(
                text = "Anyone with a Google account can join. New members start on Basic; Pro and Max " +
                    "are granted by an administrator.",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(4.dp))
            Text(
                text = "Questions? Contact ${AppConfig.supportEmail}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun SignInCard(
    signingIn: Boolean,
    error: String?,
    inviteCode: String,
    onInviteCodeChange: (String) -> Unit,
    onSignIn: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(20.dp)) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = "Join or sign in",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = "Continue with Google. First-time accounts join the member list as Basic members, " +
                    "with your name, first/last name and profile photo from your Google account.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = inviteCode,
                onValueChange = onInviteCodeChange,
                label = { Text("Invitation code (optional)") },
                placeholder = { Text("ABCD-EFGH") },
                singleLine = true,
                enabled = !signingIn,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                text = "Have a code from a colleague? Enter it before you continue: you both get " +
                    "7 days of Pro.",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            error?.let {
                Text(
                    text = it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            Button(
                onClick = onSignIn,
                enabled = !signingIn,
                modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp),
            ) {
                if (signingIn) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                } else {
                    Icon(Icons.AutoMirrored.Filled.Login, contentDescription = null, modifier = Modifier.size(18.dp))
                }
                Spacer(Modifier.width(10.dp))
                Text(if (signingIn) "Signing in…" else "Continue with Google")
            }
        }
    }
}

@Composable
private fun CheckingCard(email: String?, onSignOut: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(20.dp)) {
        Column(
            modifier = Modifier.padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            CircularProgressIndicator(modifier = Modifier.size(28.dp), strokeWidth = 3.dp)
            Text("Checking member access", style = MaterialTheme.typography.titleSmall)
            Text(
                text = email ?: "your account",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            TextButton(onClick = onSignOut) { Text("Cancel and sign out") }
        }
    }
}

@Composable
private fun NotAMemberCard(
    email: String?,
    signingIn: Boolean,
    error: String?,
    onTryAgain: () -> Unit,
    onSignOut: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(20.dp)) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Icon(Icons.Filled.Warning, contentDescription = null, tint = MaterialTheme.colorScheme.error)
                Text(
                    text = "Membership inactive",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                )
            }
            Text(
                text = "${email ?: "This account"} has a member record that is not active, so the method " +
                    "library stays locked. An administrator must set Status to Active in the Members table.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            error?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            Button(
                onClick = onTryAgain,
                enabled = !signingIn,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) {
                Text(if (signingIn) "Signing in…" else "Try another Google account")
            }
            TextButton(onClick = onSignOut) { Text("Back to start") }
            Text(
                text = "Email ${AppConfig.supportEmail} if your membership should be reactivated.",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun MembershipErrorCard(message: String?, onRetry: () -> Unit, onSignOut: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(20.dp)) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                text = "Could not check membership",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = message ?: "The member list could not be reached.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(onClick = onRetry, modifier = Modifier.fillMaxWidth()) { Text("Retry") }
            TextButton(onClick = onSignOut) { Text("Sign out") }
        }
    }
}
