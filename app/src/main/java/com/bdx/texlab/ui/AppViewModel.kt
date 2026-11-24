package com.bdx.texlab.ui

import android.app.Activity
import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.bdx.texlab.BuildConfig
import com.bdx.texlab.auth.AuthRepository
import com.bdx.texlab.auth.friendlyAuthMessage
import com.bdx.texlab.data.AdminMember
import com.bdx.texlab.data.AdminRole
import com.bdx.texlab.data.AdminSendResult
import com.bdx.texlab.data.AdminTarget
import com.bdx.texlab.data.AppConfig
import com.bdx.texlab.data.MemberMessage
import com.bdx.texlab.data.MembershipLevel
import com.bdx.texlab.data.MemberStatus
import com.bdx.texlab.data.MembershipResult
import com.bdx.texlab.data.ProxyClient
import com.bdx.texlab.data.ProxyException
import com.bdx.texlab.data.TestMethod
import com.bdx.texlab.data.UsageQuota
import com.bdx.texlab.data.isAdminRole
import com.bdx.texlab.pdf.PdfStore
import com.bdx.texlab.push.PushPrefs
import com.bdx.texlab.update.AppUpdateChecker
import com.bdx.texlab.update.AppUpdateInfo
import com.bdx.texlab.update.ApkInstaller
import com.bdx.texlab.update.InstallResult
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File

data class DownloadStatus(
    val inProgress: Boolean = false,
    val progress: Float? = null,
    val savedPath: String? = null,
    val error: String? = null,
)

/**
 * Everything the in-app admin console shows. It only exists for members whose Role is an admin
 * role; the proxy checks the same thing again on every admin request.
 */
data class AdminUiState(
    val members: List<AdminMember> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    val selected: Set<String> = emptySet(),
    val title: String = "",
    val body: String = "",
    val target: AdminTarget = AdminTarget.SELECTED,
    val level: MembershipLevel = MembershipLevel.BASIC,
    val sending: Boolean = false,
    val result: AdminSendResult? = null,
    /** The member whose detail sheet is open, and the values being edited in it. */
    val openMember: AdminMember? = null,
    val draftRole: AdminRole? = null,
    val draftLevel: MembershipLevel? = null,
    val draftStatus: MemberStatus? = null,
    val savingMember: Boolean = false,
    val memberError: String? = null,
    /** Reports and requests members sent from the app, newest first. */
    val messages: List<MemberMessage> = emptyList(),
    val messagesLoading: Boolean = false,
    val messagesError: String? = null,
) {
    /** What the detail sheet shows: the draft while editing, otherwise the saved row. */
    val editRole: AdminRole get() = draftRole ?: openMember?.adminRole ?: AdminRole.MEMBER
    val editLevel: MembershipLevel get() = draftLevel ?: openMember?.level ?: MembershipLevel.BASIC
    val editStatus: MemberStatus get() = draftStatus ?: openMember?.memberStatus ?: MemberStatus.ACTIVE

    val memberDirty: Boolean
        get() {
            val member = openMember ?: return false
            return editRole != member.adminRole ||
                editLevel != member.level ||
                editStatus != member.memberStatus
        }

    val audience: List<AdminMember>
        get() = when (target) {
            AdminTarget.SELECTED -> members.filter { it.email in selected }
            AdminTarget.EVERYONE -> members
            AdminTarget.ADMINS -> members.filter { it.isAdmin }
            AdminTarget.LEVEL -> members.filter { it.levelLabel.equals(level.label, ignoreCase = true) }
        }

    /** How many of [audience] can actually receive a push right now. */
    val reachable: Int get() = audience.count { it.device }

    val canSend: Boolean
        get() = !sending && audience.isNotEmpty() && (title.isNotBlank() || body.isNotBlank())
}

/**
 * The launch-time check against the proxy's `/api/app/latest` and the APK download that follows.
 *
 * [forced] is true when the proxy's `minSupported` is above this build: the app then shows the
 * blocking update screen instead of the library until the new APK is installed.
 */
data class UpdateUiState(
    val info: AppUpdateInfo? = null,
    val dismissed: Boolean = false,
    val downloading: Boolean = false,
    val progress: Float? = null,
    val downloaded: Boolean = false,
    val error: String? = null,
) {
    val forced: Boolean
        get() = info != null && BuildConfig.VERSION_CODE < info.minSupported

    val visible: Boolean
        get() = info != null && (forced || !dismissed)
}

data class AppUiState(
    val setupProblems: List<String> = emptyList(),
    val phase: Phase = Phase.Loading,
    val userEmail: String? = null,
    val userName: String? = null,
    val memberName: String? = null,
    val role: String? = null,
    val level: MembershipLevel? = null,
    val firstName: String? = null,
    val lastName: String? = null,
    val photoUrl: String? = null,
    /** What the proxy still allows today; replaced with each PDF response. */
    val quota: UsageQuota? = null,
    val deniedEmail: String? = null,
    val signingIn: Boolean = false,
    val authError: String? = null,
    val membershipError: String? = null,
    val methods: List<TestMethod> = emptyList(),
    val loadingMethods: Boolean = false,
    val methodsError: String? = null,
    val query: String = "",
    val downloads: Map<String, DownloadStatus> = emptyMap(),
    val message: String? = null,
    /** The member's own choice to receive lab notifications on this device. */
    val pushEnabled: Boolean = false,
    val pushBusy: Boolean = false,
    val pushError: String? = null,
    /** True only for an admin role, so the console entry point is never shown to a member. */
    val isAdmin: Boolean = false,
    val admin: AdminUiState = AdminUiState(),
    /** A newer published build, when the proxy announces one. */
    val update: UpdateUiState = UpdateUiState(),
) {
    enum class Phase {
        Loading,
        Setup,
        SignedOut,
        CheckingMembership,
        MembershipError,
        NotAMember,
        Member,
    }

    /** Methods of one table (`ISO`/`AATCC`), narrowed by the search text. */
    fun methodsIn(category: String?): List<TestMethod> {
        val needle = query.trim().lowercase()
        return methods.filter { method ->
            val matchesCategory = category == null || method.category.equals(category, ignoreCase = true)
            val matchesQuery = needle.isEmpty() || listOf(
                method.title,
                method.name,
                method.code,
                method.category,
                method.summary,
                method.standard,
                method.year,
            ).any { it.lowercase().contains(needle) }
            matchesCategory && matchesQuery
        }
    }

    /** How many methods the home screen should show on a card. */
    fun countIn(category: String): Int =
        methods.count { it.category.equals(category, ignoreCase = true) }
}

class AppViewModel(application: Application) : AndroidViewModel(application) {

    private val _state = MutableStateFlow(
        AppUiState(
            setupProblems = AppConfig.setupProblems,
            pushEnabled = PushPrefs.isEnabled(application),
        ),
    )
    val state: StateFlow<AppUiState> = _state.asStateFlow()

    private val authRepository: AuthRepository by lazy { AuthRepository(application) }

    /** Every request carries the current Firebase ID token; the server does the member check. */
    private val proxyClient: ProxyClient by lazy {
        ProxyClient(AppConfig.proxyBaseUrl) { authRepository.idToken() }
    }
    private val pdfStore: PdfStore by lazy { PdfStore(application, proxyClient) }

    /** Reads the proxy's public version document; no ID token is involved. */
    private val updateChecker by lazy { AppUpdateChecker(AppConfig.proxyBaseUrl) }
    private val apkInstaller by lazy { ApkInstaller(getApplication()) }

    init {
        if (AppConfig.setupProblems.isNotEmpty()) {
            _state.update { it.copy(phase = AppUiState.Phase.Setup) }
        } else {
            val user = authRepository.currentUser()
            if (user == null) {
                _state.update { it.copy(phase = AppUiState.Phase.SignedOut) }
            } else {
                verifyMembership(user.email.orEmpty(), user.displayName)
            }
        }
        // Independent of sign-in and never waited on: the prompt is ready by the time Home draws.
        checkForUpdate()
    }

    /**
     * Asks the proxy for the newest build once at launch. Any failure is ignored so an offline
     * start behaves exactly as before; a newer build surfaces through [AppUiState.update].
     */
    fun checkForUpdate() {
        if (!AppConfig.proxyReady) return
        if (_state.value.update.info != null) return
        viewModelScope.launch {
            val latest = updateChecker.latest() ?: return@launch
            if (latest.versionCode <= BuildConfig.VERSION_CODE) return@launch
            _state.update { it.copy(update = UpdateUiState(info = latest)) }
        }
    }

    /** "Later" on the flexible prompt; a forced update never gets this far. */
    fun dismissUpdate() {
        _state.update { it.copy(update = it.update.copy(dismissed = true)) }
    }

    /**
     * Downloads the published APK (reusing an earlier download) and starts the system installer.
     * Android always asks the member to confirm the install; nothing replaces the app silently.
     */
    fun downloadUpdate() {
        val current = _state.value.update
        val info = current.info ?: return
        if (current.downloading) return
        _state.update {
            it.copy(update = it.update.copy(downloading = true, progress = 0f, error = null))
        }
        viewModelScope.launch {
            val outcome = runCatching {
                apkInstaller.download(info) { value ->
                    _state.update { state ->
                        state.copy(update = state.update.copy(progress = value))
                    }
                }
            }
            val file = outcome.getOrNull()
            if (file == null) {
                _state.update {
                    it.copy(
                        update = it.update.copy(
                            downloading = false,
                            progress = null,
                            error = outcome.exceptionOrNull()?.message
                                ?: "The update could not be downloaded.",
                        ),
                    )
                }
                return@launch
            }

            val error = when (apkInstaller.install(info)) {
                InstallResult.STARTED -> null
                InstallResult.NEEDS_PERMISSION ->
                    "Allow TexLab to install unknown apps, then tap Install again."
                InstallResult.NO_INSTALLER -> "This device has no package installer."
            }
            _state.update {
                it.copy(
                    update = it.update.copy(
                        downloading = false,
                        progress = null,
                        downloaded = true,
                        error = error,
                    ),
                )
            }
        }
    }

    fun signIn(activity: Activity) {
        if (_state.value.signingIn) return
        _state.update { it.copy(signingIn = true, authError = null) }
        viewModelScope.launch {
            authRepository.signInWithGoogle(activity)
                .onSuccess { user ->
                    _state.update { it.copy(signingIn = false) }
                    verifyMembership(user.email.orEmpty(), user.displayName)
                }
                .onFailure { error ->
                    _state.update { it.copy(signingIn = false, authError = error.friendlyAuthMessage()) }
                }
        }
    }

    fun retryMembership() {
        val email = _state.value.userEmail
        if (email.isNullOrBlank()) {
            signOut()
            return
        }
        verifyMembership(email, _state.value.userName)
    }

    /**
     * Turns lab notifications on or off for this device. On registers this install's FCM token on
     * the member row through the proxy; off clears the row and deletes the token, so a later send
     * cannot reach a device whose member signed out.
     */
    fun setPushEnabled(enabled: Boolean) {
        if (_state.value.pushBusy || _state.value.pushEnabled == enabled) return
        val application = getApplication<Application>()
        _state.update { it.copy(pushBusy = true, pushError = null) }
        viewModelScope.launch {
            val outcome = runCatching {
                if (enabled) {
                    val token = FirebaseMessaging.getInstance().token.await()
                    proxyClient.registerPushToken(token, BuildConfig.APPLICATION_ID)
                } else {
                    proxyClient.unregisterPushToken()
                    FirebaseMessaging.getInstance().deleteToken().await()
                }
            }
            val turnedOn = enabled && outcome.isSuccess
            PushPrefs.setEnabled(application, turnedOn)
            _state.update {
                it.copy(
                    pushBusy = false,
                    pushEnabled = turnedOn,
                    pushError = when {
                        outcome.isSuccess -> null
                        enabled -> outcome.exceptionOrNull()?.message
                            ?: "Could not turn notifications on. Try again."
                        else -> "Notifications are off on this device, but the server could not be told."
                    },
                )
            }
        }
    }

    fun signOut() {
        val application = getApplication<Application>()
        if (!PushPrefs.isEnabled(application)) {
            finishSignOut()
            return
        }
        // Clear this device from the member row first, but never let the network hold sign-out.
        viewModelScope.launch {
            withTimeoutOrNull(3_000) { runCatching { proxyClient.unregisterPushToken() } }
            if (FirebaseApp.getApps(application).isNotEmpty()) {
                runCatching { FirebaseMessaging.getInstance().deleteToken().await() }
            }
            PushPrefs.setEnabled(application, false)
            finishSignOut()
        }
    }

    private fun finishSignOut() {
        authRepository.signOut()
        pdfStore.clearCache()
        _state.value = AppUiState(
            setupProblems = AppConfig.setupProblems,
            phase = AppUiState.Phase.SignedOut,
        )
    }

    fun loadMethods() {
        if (_state.value.loadingMethods) return
        _state.update { it.copy(loadingMethods = true, methodsError = null) }
        viewModelScope.launch {
            runCatching { proxyClient.loadMethods() }
                .onSuccess { methods ->
                    _state.update { it.copy(loadingMethods = false, methods = methods, methodsError = null) }
                }
                .onFailure { error ->
                    _state.update {
                        it.copy(
                            loadingMethods = false,
                            methodsError = error.message ?: "Could not load the method library.",
                        )
                    }
                }
        }
    }

    fun setQuery(query: String) {
        _state.update { it.copy(query = query) }
    }

    fun clearMessage() {
        _state.update { it.copy(message = null) }
    }

    fun download(method: TestMethod) {
        if (method.pdf == null) return
        if (_state.value.downloads[method.id]?.inProgress == true) return

        viewModelScope.launch {
            updateDownload(method.id, DownloadStatus(inProgress = true, progress = 0f))
            runCatching {
                pdfStore.downloadToDevice(method) { progress ->
                    updateDownload(method.id, DownloadStatus(inProgress = true, progress = progress))
                }
            }.onSuccess { (location, quota) ->
                quota?.let(::applyQuota)
                updateDownload(method.id, DownloadStatus(savedPath = location.displayPath))
                _state.update { it.copy(message = "Saved to ${location.displayPath}") }
            }.onFailure { error ->
                (error as? ProxyException)?.quota?.let(::applyQuota)
                updateDownload(method.id, DownloadStatus(error = error.message ?: "Download failed."))
                _state.update { it.copy(message = error.message ?: "Download failed.") }
            }
        }
    }

    /** Fetches the PDF for in-app viewing; the proxy counts one view for this. */
    suspend fun preparePdf(method: TestMethod, onProgress: (Float) -> Unit = {}): File {
        val viewed = pdfStore.fetchForView(method, onProgress)
        viewed.quota?.let(::applyQuota)
        return viewed.file
    }

    private fun applyQuota(quota: UsageQuota) {
        _state.update { it.copy(quota = quota) }
    }

    private fun verifyMembership(email: String, displayName: String?) {
        _state.update {
            it.copy(
                phase = AppUiState.Phase.CheckingMembership,
                membershipError = null,
                userEmail = email,
                userName = displayName,
            )
        }
        viewModelScope.launch {
            when (val result = proxyClient.membership()) {
                is MembershipResult.Approved -> {
                    _state.update {
                        it.copy(
                            phase = AppUiState.Phase.Member,
                            memberName = result.name.ifBlank { email.substringBefore('@') },
                            role = result.role,
                            isAdmin = isAdminRole(result.role),
                            level = result.level,
                            firstName = result.firstName.ifBlank { null },
                            lastName = result.lastName.ifBlank { null },
                            photoUrl = result.photoUrl,
                            quota = result.quota,
                            deniedEmail = null,
                            membershipError = null,
                            pushEnabled = PushPrefs.isEnabled(getApplication()),
                        )
                    }
                    loadMethods()
                    syncPushToken()
                }

                MembershipResult.NotAMember -> {
                    authRepository.signOut()
                    _state.update {
                        it.copy(
                            phase = AppUiState.Phase.NotAMember,
                            deniedEmail = email,
                            userEmail = null,
                            memberName = null,
                            role = null,
                            isAdmin = false,
                            admin = AdminUiState(),
                            level = null,
                            firstName = null,
                            lastName = null,
                            photoUrl = null,
                            quota = null,
                            methods = emptyList(),
                        )
                    }
                }

                is MembershipResult.Failed -> {
                    _state.update {
                        it.copy(
                            phase = AppUiState.Phase.MembershipError,
                            membershipError = result.message,
                        )
                    }
                }
            }
        }
    }

    /**
     * After a sign-in the device token is registered again when the member had notifications on:
     * FCM may rotate it, and the row is the only place the console can find this device.
     */
    private fun syncPushToken() {
        val application = getApplication<Application>()
        if (!PushPrefs.isEnabled(application)) return
        if (FirebaseApp.getApps(application).isEmpty()) return
        viewModelScope.launch {
            runCatching {
                val token = FirebaseMessaging.getInstance().token.await()
                proxyClient.registerPushToken(token, BuildConfig.APPLICATION_ID)
            }
        }
    }

    // ----------------------------------------------------------------- admin console

    /** Loaded when an admin opens the console; a member can never reach this. */
    fun loadAdminMembers() {
        val current = _state.value
        if (!current.isAdmin || current.admin.loading) return
        _state.update { it.copy(admin = it.admin.copy(loading = true, error = null)) }
        viewModelScope.launch {
            runCatching { proxyClient.adminMembers() }
                .onSuccess { members ->
                    _state.update { state ->
                        val emails = members.mapTo(mutableSetOf()) { it.email }
                        state.copy(
                            admin = state.admin.copy(
                                members = members,
                                loading = false,
                                error = null,
                                selected = state.admin.selected.filterTo(mutableSetOf()) { it in emails },
                                result = null,
                            ),
                        )
                    }
                }
                .onFailure { error ->
                    _state.update { state ->
                        state.copy(
                            admin = state.admin.copy(
                                loading = false,
                                error = error.message ?: "Could not load the member list.",
                            ),
                        )
                    }
                }
        }
    }

    /** Loads the member inbox for an admin; a member role never gets this far. */
    fun loadAdminMessages() {
        val current = _state.value
        if (!current.isAdmin || current.admin.messagesLoading) return
        _state.update {
            it.copy(admin = it.admin.copy(messagesLoading = true, messagesError = null))
        }
        viewModelScope.launch {
            runCatching { proxyClient.adminMessages() }
                .onSuccess { messages ->
                    _state.update { state ->
                        state.copy(
                            admin = state.admin.copy(
                                messages = messages,
                                messagesLoading = false,
                                messagesError = null,
                            ),
                        )
                    }
                }
                .onFailure { error ->
                    _state.update { state ->
                        state.copy(
                            admin = state.admin.copy(
                                messagesLoading = false,
                                messagesError = error.message ?: "Could not load member messages.",
                            ),
                        )
                    }
                }
        }
    }

    /**
     * Sends one report or request to the proxy, which stores it for the admin console. Throws on
     * failure so the screen can show the server's own message.
     */
    suspend fun sendMemberMessage(kind: String, subject: String, message: String) {
        val hardware = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
        val device = listOf(hardware, "Android ${Build.VERSION.RELEASE}")
            .filter { it.isNotBlank() }
            .joinToString(" · ")
        proxyClient.submitMessage(
            kind = kind,
            subject = subject,
            message = message,
            appVersion = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
            device = device,
        )
    }

    fun setAdminTitle(title: String) {
        _state.update { it.copy(admin = it.admin.copy(title = title.take(120), error = null)) }
    }

    fun setAdminBody(body: String) {
        _state.update { it.copy(admin = it.admin.copy(body = body.take(600), error = null)) }
    }

    fun setAdminTarget(target: AdminTarget) {
        _state.update { it.copy(admin = it.admin.copy(target = target, error = null)) }
    }

    fun setAdminLevel(level: MembershipLevel) {
        _state.update { it.copy(admin = it.admin.copy(level = level, error = null)) }
    }

    /** Opens one member's detail sheet, seeded with the values saved on their row. */
    fun openAdminMember(memberId: String) {
        _state.update { state ->
            val member = state.admin.members.firstOrNull { it.id == memberId }
                ?: state.admin.members.firstOrNull { it.email == memberId }
                ?: return@update state
            state.copy(
                admin = state.admin.copy(
                    openMember = member,
                    draftRole = member.adminRole,
                    draftLevel = member.level,
                    draftStatus = member.memberStatus,
                    savingMember = false,
                    memberError = null,
                ),
            )
        }
    }

    fun closeAdminMember() {
        _state.update { state ->
            state.copy(
                admin = state.admin.copy(
                    openMember = null,
                    draftRole = null,
                    draftLevel = null,
                    draftStatus = null,
                    savingMember = false,
                    memberError = null,
                ),
            )
        }
    }

    fun setAdminDraftRole(role: AdminRole) {
        _state.update { it.copy(admin = it.admin.copy(draftRole = role, memberError = null)) }
    }

    fun setAdminDraftLevel(level: MembershipLevel) {
        _state.update { it.copy(admin = it.admin.copy(draftLevel = level, memberError = null)) }
    }

    fun setAdminDraftStatus(status: MemberStatus) {
        _state.update { it.copy(admin = it.admin.copy(draftStatus = status, memberError = null)) }
    }

    /** Writes only the fields the admin actually changed, then updates the row in place. */
    fun saveAdminMember() {
        val current = _state.value
        val admin = current.admin
        val member = admin.openMember ?: return
        if (!current.isAdmin || admin.savingMember || !admin.memberDirty) return

        val role = admin.editRole.takeIf { it != member.adminRole }?.label
        val level = admin.editLevel.takeIf { it != member.level }?.name?.lowercase()
        val status = admin.editStatus.takeIf { it != member.memberStatus }?.label

        _state.update { it.copy(admin = it.admin.copy(savingMember = true, memberError = null)) }
        viewModelScope.launch {
            runCatching { proxyClient.adminUpdateMember(member.id, role = role, level = level, status = status) }
                .onSuccess { updated ->
                    _state.update { state ->
                        state.copy(
                            // An admin who raised their own level sees the new allowance right away.
                            level = if (state.userEmail.equals(updated.email, ignoreCase = true)) {
                                updated.level
                            } else {
                                state.level
                            },
                            admin = state.admin.copy(
                                members = state.admin.members.map { row ->
                                    if (row.id == updated.id) updated else row
                                },
                                openMember = updated,
                                draftRole = updated.adminRole,
                                draftLevel = updated.level,
                                draftStatus = updated.memberStatus,
                                savingMember = false,
                                memberError = null,
                            ),
                        )
                    }
                }
                .onFailure { error ->
                    _state.update { state ->
                        state.copy(
                            admin = state.admin.copy(
                                savingMember = false,
                                memberError = error.message ?: "The member could not be saved.",
                            ),
                        )
                    }
                }
        }
    }

    fun toggleAdminMember(email: String) {
        _state.update { state ->
            val selected = state.admin.selected.toMutableSet()
            if (!selected.add(email)) selected.remove(email)
            state.copy(admin = state.admin.copy(selected = selected, error = null))
        }
    }

    /** Ticks every member that currently has a device registered. */
    fun selectReachableAdminMembers() {
        _state.update { state ->
            state.copy(
                admin = state.admin.copy(
                    selected = state.admin.members.filter { it.device }.mapTo(mutableSetOf()) { it.email },
                    error = null,
                ),
            )
        }
    }

    fun clearAdminSelection() {
        _state.update { it.copy(admin = it.admin.copy(selected = emptySet(), error = null)) }
    }

    /** Sends the drafted notification through the proxy's admin endpoint. */
    fun sendAdminNotification() {
        val current = _state.value
        if (!current.isAdmin || current.admin.sending) return
        val admin = current.admin

        if (admin.title.isBlank() && admin.body.isBlank()) {
            _state.update { it.copy(admin = it.admin.copy(error = "Write a title or a message first.")) }
            return
        }
        if (admin.audience.isEmpty()) {
            _state.update { it.copy(admin = it.admin.copy(error = "Choose at least one member to notify.")) }
            return
        }

        val targetMode = when (admin.target) {
            AdminTarget.SELECTED, AdminTarget.EVERYONE -> "all members"
            AdminTarget.ADMINS -> "admin only"
            AdminTarget.LEVEL -> "level"
        }
        // "Selected" is expressed as everyone else being suppressed, which is what the Worker takes.
        val suppressed = if (admin.target == AdminTarget.SELECTED) {
            admin.members
                .filterNot { it.email in admin.selected }
                .joinToString(", ") { it.email }
        } else {
            ""
        }

        _state.update { it.copy(admin = it.admin.copy(sending = true, error = null, result = null)) }
        viewModelScope.launch {
            runCatching {
                proxyClient.adminNotify(
                    title = admin.title.trim(),
                    body = admin.body.trim(),
                    targetMode = targetMode,
                    targetLevel = if (admin.target == AdminTarget.LEVEL) admin.level.name.lowercase() else "",
                    suppressedEmails = suppressed,
                )
            }.onSuccess { result ->
                _state.update { it.copy(admin = it.admin.copy(sending = false, result = result)) }
            }.onFailure { error ->
                _state.update {
                    it.copy(
                        admin = it.admin.copy(
                            sending = false,
                            error = error.message ?: "The notification could not be sent.",
                        ),
                    )
                }
            }
        }
    }

    private fun updateDownload(id: String, status: DownloadStatus) {
        _state.update { current -> current.copy(downloads = current.downloads + (id to status)) }
    }
}
