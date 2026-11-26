package com.bdx.texlab.data

import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

/** A failure reported by the proxy (or by the network on the way to it). */
class ProxyException(
    message: String,
    val status: Int? = null,
    /** Today's counters, when the proxy sent them with the failed response. */
    val quota: UsageQuota? = null,
    cause: Throwable? = null,
) : Exception(message, cause)

/** Why a PDF is being fetched; the proxy counts views and downloads separately. */
enum class FileMode(val value: String) {
    VIEW("view"),
    DOWNLOAD("download"),

    /** Printing: charged as a download, but the proxy sends no PDF because the viewer has it. */
    PRINT("print"),
}

@Serializable
private data class MethodsResponse(val methods: List<MethodDto> = emptyList())

@Serializable
private data class MethodDto(
    val id: String = "",
    val title: String = "",
    val code: String = "",
    val name: String = "",
    val year: String = "",
    val category: String = "",
    val summary: String = "",
    val standard: String = "",
    val pdf: PdfAttachment? = null,
)

@Serializable
private data class UsageDto(
    val viewsLimit: Int = 0,
    val viewsUsed: Int = 0,
    val downloadsLimit: Int = 0,
    val downloadsUsed: Int = 0,
    val asksLimit: Int = 0,
    val asksUsed: Int = 0,
)

@Serializable
private data class MemberResponse(
    val member: Boolean = false,
    val name: String? = null,
    val role: String? = null,
    val level: String? = null,
    val firstName: String? = null,
    val lastName: String? = null,
    val photoUrl: String? = null,
    val usage: UsageDto? = null,
    val proUntil: String? = null,
)

@Serializable
private data class ErrorResponse(val error: String = "", val message: String? = null)

@Serializable
private data class PushTokenBody(val token: String, val appId: String)

@Serializable
private data class MessageBody(
    val kind: String,
    val subject: String,
    val message: String,
    val appVersion: String,
    val device: String,
)

@Serializable
private data class MemberMessagesResponse(val messages: List<MemberMessageDto> = emptyList())

@Serializable
private data class MemberMessageDto(
    val id: String = "",
    val email: String = "",
    val name: String = "",
    val kind: String = "",
    val subject: String = "",
    val message: String = "",
    val appVersion: String = "",
    val device: String = "",
    val status: String = "",
    val createdAt: String = "",
)

@Serializable
private data class ChatTurnDto(val role: String, val text: String)

@Serializable
private data class InviteResponse(
    val code: String = "",
    val proUntil: String? = null,
    val trialDays: Int = 7,
    val invites: Int = 0,
    val redeemed: Boolean = false,
)

@Serializable
private data class RedeemInviteBody(val code: String)

@Serializable
private data class RedeemInviteResponse(
    val ok: Boolean = false,
    val proUntil: String? = null,
    val trialDays: Int = 7,
    val level: String? = null,
    val levelLabel: String? = null,
)

/** What a successful redemption changed: the member's new level and when the trial ends. */
data class InviteRedeemResult(
    val level: MembershipLevel,
    val proUntil: String? = null,
    val trialDays: Int = 7,
) {
    val proUntilLabel: String? get() = InviteInfo(proUntil = proUntil).proUntilLabel
}

@Serializable
private data class MethodUploadBody(
    val title: String,
    val filename: String,
    val contentType: String,
    val file: String,
)

@Serializable
private data class MethodUploadResponse(
    val ok: Boolean = false,
    val id: String = "",
    val status: String = "",
    val note: String = "",
)

@Serializable
private data class AskDocumentBody(
    val methodId: String,
    val question: String,
    val history: List<ChatTurnDto> = emptyList(),
)

@Serializable
private data class DocumentAnswerResponse(
    val answer: String = "",
    val usage: UsageDto? = null,
)

/** One assistant answer and the day's counters that came back with it. */
data class DocumentAnswer(
    val text: String,
    val asksLimit: Int = 0,
    val asksUsed: Int = 0,
)

@Serializable
private data class AdminMembersResponse(val members: List<AdminMemberDto> = emptyList())

@Serializable
private data class AdminMemberResponse(val ok: Boolean = false, val member: AdminMemberDto? = null)

@Serializable
private data class AdminMemberDto(
    val id: String = "",
    val email: String = "",
    val name: String = "",
    val firstName: String = "",
    val lastName: String = "",
    val level: String = "",
    val levelLabel: String = "",
    val role: String = "",
    val status: String = "",
    val photoUrl: String? = null,
    val fcmRegistered: Boolean = false,
    val fcmRegisteredAt: String = "",
    val lastActiveAt: String? = null,
    val online: Boolean = false,
    val usage: AdminUsageDto? = null,
)

@Serializable
private data class AdminUsageDto(
    val viewsLimit: Int = 0,
    val viewsUsed: Int = 0,
    val downloadsLimit: Int = 0,
    val downloadsUsed: Int = 0,
)

@Serializable
private data class AdminNotifyBody(
    val title: String,
    val body: String,
    val targetMode: String,
    val targetLevel: String = "",
    val suppressedEmails: String = "",
)

@Serializable
private data class AdminNotifyResponse(
    val targeted: Int = 0,
    val sent: Int = 0,
    val failed: Int = 0,
    val skipped: List<String> = emptyList(),
    val results: List<AdminNotifyEntry> = emptyList(),
)

@Serializable
private data class AdminNotifyEntry(
    val email: String = "",
    val ok: Boolean = false,
    val error: String? = null,
)

/**
 * Talks to the lab's proxy server, never to Airtable directly.
 *
 * Every call carries a fresh Firebase ID token. The proxy verifies that token, checks the
 * member list itself and only then returns methods or PDF bytes, so the Airtable token and the
 * member gate live outside the APK.
 */
class ProxyClient(
    baseUrl: String,
    private val idToken: suspend () -> String?,
) {
    private val base = baseUrl.trim().trimEnd('/')

    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    suspend fun membership(): MembershipResult = withContext(Dispatchers.IO) {
        try {
            http.newCall(request("/api/me")).execute().use { response ->
                val body = response.body?.string().orEmpty()
                when {
                    response.isSuccessful -> {
                        val member = json.decodeFromString<MemberResponse>(body)
                        MembershipResult.Approved(
                            name = member.name?.trim().orEmpty(),
                            role = member.role?.trim().takeUnless { it.isNullOrBlank() } ?: "Member",
                            level = MembershipLevel.from(member.level),
                            firstName = member.firstName?.trim().orEmpty(),
                            lastName = member.lastName?.trim().orEmpty(),
                            photoUrl = member.photoUrl?.trim()?.takeIf { it.startsWith("http") },
                            quota = member.usage?.toQuota(member.level),
                            proUntil = member.proUntil,
                        )
                    }

                    response.code == 403 -> MembershipResult.NotAMember
                    else -> MembershipResult.Failed(describe(response.code, body))
                }
            }
        } catch (error: Exception) {
            MembershipResult.Failed(friendlyMessage(error))
        }
    }

    suspend fun loadMethods(): List<TestMethod> = withContext(Dispatchers.IO) {
        http.newCall(request("/api/methods")).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw ProxyException(describe(response.code, body), response.code)
            json.decodeFromString<MethodsResponse>(body)
                .methods
                .filter { it.id.isNotBlank() && it.title.isNotBlank() }
                .map { it.toTestMethod() }
        }
    }

    /**
     * Streams a PDF from the proxy. [path] is the relative URL returned with a method, and
     * [mode] tells the proxy whether this is a view or a download (each has a daily limit).
     * Returns today's counters as reported by the proxy, when it sends them.
     */
    suspend fun download(
        path: String,
        destination: File,
        mode: FileMode = FileMode.VIEW,
        onProgress: (Float) -> Unit = {},
    ): UsageQuota? = withContext(Dispatchers.IO) {
            destination.parentFile?.mkdirs()
            val url = withMode(path, mode)
            http.newCall(request(url, accept = "application/pdf")).execute().use { response ->
                val quota = quotaFrom(response)
                if (!response.isSuccessful) {
                    throw ProxyException(
                        describe(response.code, response.body?.string().orEmpty()),
                        response.code,
                        quota,
                    )
                }
                val body = response.body ?: throw ProxyException("The PDF download was empty.")
                val total = body.contentLength()
                body.byteStream().use { input ->
                    destination.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var copied = 0L
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            output.write(buffer, 0, read)
                            copied += read
                            if (total > 0) {
                                onProgress((copied.toFloat() / total.toFloat()).coerceIn(0f, 1f))
                            }
                        }
                    }
                }
                if (destination.length() == 0L) throw ProxyException("The downloaded PDF is empty.")
                onProgress(1f)
                quota
            }
        }

    /**
     * Charges one download for printing a PDF the viewer already holds. The proxy answers 204
     * with today's counters instead of streaming the file again, so printing costs no extra data.
     */
    suspend fun chargePrint(path: String): UsageQuota? = withContext(Dispatchers.IO) {
        http.newCall(request(withMode(path, FileMode.PRINT))).execute().use { response ->
            val quota = quotaFrom(response)
            if (!response.isSuccessful) {
                throw ProxyException(
                    describe(response.code, response.body?.string().orEmpty()),
                    response.code,
                    quota,
                )
            }
            response.body?.close()
            quota
        }
    }

    /**
     * Registers this install's Firebase device token against the signed-in member row. The proxy
     * ties it to the account the ID token belongs to, so a send from the admin console reaches this
     * device only while that member still has notifications on.
     */
    suspend fun registerPushToken(token: String, appId: String): Unit = withContext(Dispatchers.IO) {
        val body = json.encodeToString(
            PushTokenBody.serializer(),
            PushTokenBody(token = token, appId = appId),
        )
        post("/api/notifications/register", body)
    }

    /** Forgets this device on the member row (notifications turned off, or signing out). */
    suspend fun unregisterPushToken(): Unit = withContext(Dispatchers.IO) {
        post("/api/notifications/unregister", "{}")
    }

    /**
     * Stores one report or request for the lab administrator. The proxy writes it to the Messages
     * table and ties it to the signed-in member itself, so no email app is involved.
     */
    suspend fun submitMessage(
        kind: String,
        subject: String,
        message: String,
        appVersion: String,
        device: String,
    ): Unit = withContext(Dispatchers.IO) {
        val payload = json.encodeToString(
            MessageBody.serializer(),
            MessageBody(
                kind = kind,
                subject = subject,
                message = message,
                appVersion = appVersion,
                device = device,
            ),
        )
        post("/api/messages", payload)
    }

    /**
     * The member's own invitation code, with the number of members who joined with it and any
     * running Pro trial. The proxy creates the code the first time it is asked for.
     */
    suspend fun invite(): InviteInfo = withContext(Dispatchers.IO) {
        http.newCall(request("/api/invite")).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw ProxyException(describe(response.code, body), response.code)
            val dto = json.decodeFromString<InviteResponse>(body)
            InviteInfo(
                code = dto.code,
                proUntil = dto.proUntil,
                trialDays = dto.trialDays,
                invites = dto.invites,
                redeemed = dto.redeemed,
            )
        }
    }

    /**
     * Redeems a colleague's invitation code. Both members get [trialDays] of Pro; the proxy refuses
     * a code that does not exist, the member's own code, and a second redemption.
     */
    suspend fun redeemInvite(code: String): InviteRedeemResult = withContext(Dispatchers.IO) {
        val payload = json.encodeToString(RedeemInviteBody.serializer(), RedeemInviteBody(code = code))
        val raw = post("/api/invite/redeem", payload)
        val dto = json.decodeFromString<RedeemInviteResponse>(raw)
        InviteRedeemResult(
            level = MembershipLevel.from(dto.level ?: dto.levelLabel),
            proUntil = dto.proUntil,
            trialDays = dto.trialDays,
        )
    }

    /**
     * Submits one method/document for review. The Worker stores it in the uploads table with the
     * signed-in member's verified email and attaches the file itself; an administrator then
     * approves it with 1–30 days of Pro.
     */
    suspend fun uploadMethod(
        title: String,
        filename: String,
        contentType: String,
        bytes: ByteArray,
    ): MethodUploadResult = withContext(Dispatchers.IO) {
        val payload = json.encodeToString(
            MethodUploadBody.serializer(),
            MethodUploadBody(
                title = title,
                filename = filename,
                contentType = contentType,
                file = Base64.encodeToString(bytes, Base64.NO_WRAP),
            ),
        )
        val raw = post("/api/method-uploads", payload)
        val response = json.decodeFromString<MethodUploadResponse>(raw)
        MethodUploadResult(
            status = response.status.ifBlank { "Pending" },
            note = response.note,
        )
    }

    /**
     * The member inbox for the admin console. Admin-only on the proxy, newest message first.
     */
    suspend fun adminMessages(): List<MemberMessage> = withContext(Dispatchers.IO) {
        http.newCall(request("/api/admin/messages")).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw ProxyException(describe(response.code, body), response.code)
            json.decodeFromString<MemberMessagesResponse>(body)
                .messages
                .filter { it.message.isNotBlank() || it.subject.isNotBlank() }
                .map { it.toMemberMessage() }
        }
    }

    /**
     * Asks the document assistant a question about one method. The Worker builds the document
     * text from the Airtable row and calls Gemini with its own key, so this app never holds an
     * AI credential; [history] is the visible conversation so far, oldest first, as
     * (role, text) pairs with role `user` or `model`.
     */
    suspend fun askDocument(
        methodId: String,
        question: String,
        history: List<Pair<String, String>> = emptyList(),
    ): DocumentAnswer = withContext(Dispatchers.IO) {
        val payload = json.encodeToString(
            AskDocumentBody.serializer(),
            AskDocumentBody(
                methodId = methodId,
                question = question,
                history = history.map { (role, text) -> ChatTurnDto(role = role, text = text) },
            ),
        )
        val raw = post("/api/documents/ask", payload)
        val response = json.decodeFromString<DocumentAnswerResponse>(raw)
        DocumentAnswer(
            text = response.answer.trim(),
            asksLimit = response.usage?.asksLimit ?: 0,
            asksUsed = response.usage?.asksUsed ?: 0,
        )
    }

    /**
     * The admin console's member list. The proxy refuses every account whose role is not an admin
     * role, so an ordinary member cannot reach this even with a patched APK.
     */
    suspend fun adminMembers(): List<AdminMember> = withContext(Dispatchers.IO) {
        http.newCall(request("/api/admin/members")).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw ProxyException(describe(response.code, body), response.code)
            json.decodeFromString<AdminMembersResponse>(body)
                .members
                .filter { it.email.isNotBlank() }
                .map { it.toAdminMember() }
        }
    }

    /**
     * Changes one member's role, membership level or status. Only the fields passed are written;
     * the Worker rejects unknown values and refuses to demote the signed-in admin's own row.
     * Returns the member row as the proxy now sees it.
     */
    suspend fun adminUpdateMember(
        recordId: String,
        role: String? = null,
        level: String? = null,
        status: String? = null,
    ): AdminMember = withContext(Dispatchers.IO) {
        val payload = buildJsonObject {
            role?.let { put("role", it) }
            level?.let { put("level", it) }
            status?.let { put("status", it) }
        }
        val raw = send(
            path = "/api/admin/members/${recordId.trim()}",
            body = payload.toString(),
            method = "PATCH",
        )
        val member = json.decodeFromString<AdminMemberResponse>(raw).member
            ?: throw ProxyException("The member was saved but the server sent no row back.")
        member.toAdminMember()
    }

    /** Sends one notification; [targetMode] is the Worker's own vocabulary. */
    suspend fun adminNotify(
        title: String,
        body: String,
        targetMode: String,
        targetLevel: String,
        suppressedEmails: String,
    ): AdminSendResult = withContext(Dispatchers.IO) {
        val payload = json.encodeToString(
            AdminNotifyBody.serializer(),
            AdminNotifyBody(
                title = title,
                body = body,
                targetMode = targetMode,
                targetLevel = targetLevel,
                suppressedEmails = suppressedEmails,
            ),
        )
        val raw = post("/api/admin/notify", payload)
        val result = json.decodeFromString<AdminNotifyResponse>(raw)
        AdminSendResult(
            targeted = result.targeted,
            sent = result.sent,
            failed = result.failed,
            skipped = result.skipped,
            failures = result.results
                .filterNot { it.ok }
                .map { it.email to (it.error ?: "failed") },
        )
    }

    private suspend fun post(path: String, body: String): String = send(path, body, "POST")

    private suspend fun send(path: String, body: String, method: String): String {
        val request = request(path).newBuilder()
            .method(method, body.toRequestBody("application/json; charset=utf-8".toMediaType()))
            .build()
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw ProxyException(describe(response.code, text), response.code, quotaFrom(response))
            }
            return text
        }
    }

    private fun withMode(path: String, mode: FileMode): String {
        val separator = if (path.contains('?')) '&' else '?'
        return "$path${separator}mode=${mode.value}"
    }

    /** Today's counters from the `X-Quota-*` headers, if the proxy sent them all. */
    private fun quotaFrom(response: Response): UsageQuota? {
        fun int(name: String) = response.header(name)?.toIntOrNull()
        val viewsLimit = int("X-Quota-Views-Limit") ?: return null
        return UsageQuota(
            level = MembershipLevel.from(response.header("X-Quota-Level")),
            viewsLimit = viewsLimit,
            viewsUsed = int("X-Quota-Views-Used") ?: 0,
            downloadsLimit = int("X-Quota-Downloads-Limit") ?: 0,
            downloadsUsed = int("X-Quota-Downloads-Used") ?: 0,
            asksLimit = int("X-Quota-Asks-Limit") ?: 0,
            asksUsed = int("X-Quota-Asks-Used") ?: 0,
        )
    }

    private suspend fun request(path: String, accept: String = "application/json"): Request {
        val token = idToken()?.takeIf { it.isNotBlank() }
            ?: throw ProxyException("Your session expired. Sign in again.", 401)
        return Request.Builder()
            .url("$base/${path.trimStart('/')}")
            .header("Authorization", "Bearer $token")
            .header("Accept", accept)
            .build()
    }

    private fun describe(code: Int, body: String): String {
        val detail = runCatching {
            json.decodeFromString<ErrorResponse>(body).message?.takeIf { it.isNotBlank() }
        }.getOrNull()
        return when (code) {
            401 -> detail ?: "Your session expired. Sign in again."
            403 -> detail ?: "This account is not on the member list."
            404 -> detail ?: "That method is no longer available."
            429 -> detail ?: "Your plan's allowance for today is used up. It resets at 00:00 UTC."
            502 -> detail ?: "The method server cannot reach the library right now."
            else -> detail ?: "The method server returned HTTP $code."
        }
    }

    private fun friendlyMessage(error: Exception): String = when (error) {
        is ProxyException -> error.message ?: "Could not check membership."
        is IOException -> "Could not reach the method server. Check your connection."
        else -> error.message ?: "Could not check membership."
    }
}

private fun UsageDto.toQuota(level: String?) = UsageQuota(
    level = MembershipLevel.from(level),
    viewsLimit = viewsLimit,
    viewsUsed = viewsUsed,
    downloadsLimit = downloadsLimit,
    downloadsUsed = downloadsUsed,
    asksLimit = asksLimit,
    asksUsed = asksUsed,
)

private fun MemberMessageDto.toMemberMessage() = MemberMessage(
    id = id,
    email = email,
    name = name,
    kind = kind.ifBlank { "Report" },
    subject = subject,
    message = message,
    appVersion = appVersion,
    device = device,
    status = status,
    createdAt = createdAt,
)

private fun AdminMemberDto.toAdminMember() = AdminMember(
    id = id,
    email = email,
    name = name,
    levelLabel = levelLabel.ifBlank { level.replaceFirstChar { it.uppercase() }.ifBlank { "Basic" } },
    role = role.ifBlank { "Member" },
    device = fcmRegistered,
    firstName = firstName,
    lastName = lastName,
    status = status,
    photoUrl = photoUrl?.takeIf { it.startsWith("http") },
    registeredAt = fcmRegisteredAt,
    lastActiveAt = lastActiveAt.orEmpty(),
    online = online,
    viewsUsed = usage?.viewsUsed ?: 0,
    viewsLimit = usage?.viewsLimit ?: 0,
    downloadsUsed = usage?.downloadsUsed ?: 0,
    downloadsLimit = usage?.downloadsLimit ?: 0,
)

private fun MethodDto.toTestMethod() = TestMethod(
    id = id,
    title = title,
    code = code,
    name = name,
    year = year,
    category = category,
    summary = summary,
    standard = standard,
    pdf = pdf?.takeIf { it.url.isNotBlank() },
)
