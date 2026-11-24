package com.bdx.texlab.ui

import android.app.Activity
import android.net.Uri
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.bdx.texlab.push.NotificationHistory
import com.bdx.texlab.ui.screens.AboutScreen
import com.bdx.texlab.ui.screens.AdminConsoleScreen
import com.bdx.texlab.ui.screens.AdminMemberSheet
import com.bdx.texlab.ui.screens.ContactAdminScreen
import com.bdx.texlab.ui.screens.HomeScreen
import com.bdx.texlab.ui.screens.MethodDetailScreen
import com.bdx.texlab.ui.screens.MethodListScreen
import com.bdx.texlab.ui.screens.NotificationHistoryScreen
import com.bdx.texlab.ui.screens.ForcedUpdateScreen
import com.bdx.texlab.ui.screens.SetupScreen
import com.bdx.texlab.ui.screens.SignInScreen
import com.bdx.texlab.ui.screens.UpdateDialog
import com.bdx.texlab.ui.screens.ViewerScreen

@Composable
fun TexLabApp(viewModel: AppViewModel, activity: Activity) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val update = state.update

    // A build below the proxy's minSupported cannot use the library until it is updated.
    if (update.forced) {
        ForcedUpdateScreen(update = update, onUpdate = viewModel::downloadUpdate)
        return
    }

    when (state.phase) {
        AppUiState.Phase.Setup -> SetupScreen(problems = state.setupProblems)
        AppUiState.Phase.Loading -> Surface(modifier = Modifier.fillMaxSize()) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        }

        AppUiState.Phase.Member -> MemberArea(state = state, viewModel = viewModel)
        else -> SignInScreen(
            state = state,
            onSignIn = { viewModel.signIn(activity) },
            onRetryMembership = viewModel::retryMembership,
            onSignOut = viewModel::signOut,
        )
    }

    if (update.visible) {
        UpdateDialog(
            update = update,
            onUpdate = viewModel::downloadUpdate,
            onLater = viewModel::dismissUpdate,
        )
    }
}

/**
 * Home -> standard family (ISO / AATCC) -> method details -> PDF viewer.
 */
@Composable
private fun MemberArea(state: AppUiState, viewModel: AppViewModel) {
    val navController = rememberNavController()
    val context = LocalContext.current
    val notifications by NotificationHistory.items.collectAsStateWithLifecycle()
    val unseenNotifications by NotificationHistory.unseenCount.collectAsStateWithLifecycle()

    LaunchedEffect(Unit) { NotificationHistory.ensureLoaded(context) }

    NavHost(navController = navController, startDestination = "home") {
        composable("home") {
            HomeScreen(
                state = state,
                onOpenCategory = { family -> navController.navigate("family/${Uri.encode(family)}") },
                onRefresh = viewModel::loadMethods,
                onTogglePush = viewModel::setPushEnabled,
                onOpenAdmin = { navController.navigate("admin") },
                onOpenContact = { navController.navigate("contact") },
                onOpenAbout = { navController.navigate("about") },
                onOpenNotifications = { navController.navigate("notifications") },
                unseenNotifications = unseenNotifications,
                onSignOut = viewModel::signOut,
            )
        }

        // A member's report or request, stored by the proxy for the admin console.
        composable("contact") {
            ContactAdminScreen(
                memberEmail = state.userEmail,
                onSend = viewModel::sendMemberMessage,
                onBack = { navController.popBackStack() },
            )
        }

        composable("about") {
            AboutScreen(
                memberName = state.memberName,
                memberEmail = state.userEmail,
                levelLabel = state.level?.label,
                onBack = { navController.popBackStack() },
            )
        }

        // The bell on the home screen opens the member's own history of console messages.
        composable("notifications") {
            LaunchedEffect(Unit) { NotificationHistory.markSeen(context) }
            NotificationHistoryScreen(
                messages = notifications,
                onBack = { navController.popBackStack() },
                onClear = { NotificationHistory.clear(context) },
            )
        }

        // Admin-only: the route is reachable only from the button HomeScreen shows for an admin
        // role, and the screen itself refuses to render for a member.
        composable("admin") {
            LaunchedEffect(Unit) {
                viewModel.loadAdminMembers()
                viewModel.loadAdminMessages()
            }
            AdminConsoleScreen(
                state = state,
                onBack = { navController.popBackStack() },
                onRefresh = {
                    viewModel.loadAdminMembers()
                    viewModel.loadAdminMessages()
                },
                onToggleMember = viewModel::toggleAdminMember,
                onSelectReachable = viewModel::selectReachableAdminMembers,
                onClearSelection = viewModel::clearAdminSelection,
                onTitleChange = viewModel::setAdminTitle,
                onBodyChange = viewModel::setAdminBody,
                onTargetChange = viewModel::setAdminTarget,
                onLevelChange = viewModel::setAdminLevel,
                onSend = viewModel::sendAdminNotification,
                onOpenMember = viewModel::openAdminMember,
            )

            // The member detail sheet sits above the console: tap a row to open it.
            val admin = state.admin
            admin.openMember?.let { member ->
                AdminMemberSheet(
                    member = member,
                    role = admin.editRole,
                    level = admin.editLevel,
                    status = admin.editStatus,
                    saving = admin.savingMember,
                    error = admin.memberError,
                    canSave = admin.memberDirty && !admin.savingMember,
                    onRoleChange = viewModel::setAdminDraftRole,
                    onLevelChange = viewModel::setAdminDraftLevel,
                    onStatusChange = viewModel::setAdminDraftStatus,
                    onSave = viewModel::saveAdminMember,
                    onDismiss = viewModel::closeAdminMember,
                )
            }
        }

        composable("family/{family}") { entry ->
            val family = entry.arguments?.getString("family").orEmpty()
            MethodListScreen(
                category = family,
                state = state,
                onBack = { navController.popBackStack() },
                onQueryChange = viewModel::setQuery,
                onRefresh = viewModel::loadMethods,
                onOpenMethod = { method -> navController.navigate("method/${Uri.encode(method.id)}") },
            )
        }

        composable("method/{methodId}") { entry ->
            val methodId = entry.arguments?.getString("methodId").orEmpty()
            val method = state.methods.firstOrNull { it.id == methodId }
            MethodDetailScreen(
                method = method,
                quota = state.quota,
                downloadStatus = state.downloads[methodId],
                message = state.message,
                onMessageShown = viewModel::clearMessage,
                onBack = { navController.popBackStack() },
                onView = { navController.navigate("viewer/${Uri.encode(methodId)}") },
                onDownload = { method?.let(viewModel::download) },
                chat = state.chat,
                onAskAi = { method?.let(viewModel::openDocumentChat) },
                onDismissChat = viewModel::closeDocumentChat,
                onAskDocument = viewModel::askDocument,
            )
        }

        composable("viewer/{methodId}") { entry ->
            val methodId = entry.arguments?.getString("methodId").orEmpty()
            val method = state.methods.firstOrNull { it.id == methodId }
            ViewerScreen(
                method = method,
                onBack = { navController.popBackStack() },
                onDownload = viewModel::download,
                preparePdf = { target, progress -> viewModel.preparePdf(target, progress) },
            )
        }
    }
}
