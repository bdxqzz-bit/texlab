package com.bdx.texlab.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
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
)

@Serializable
private data class ErrorResponse(val error: String = "", val message: String? = null)

@Serializable
private data class PushTokenBody(val token: String, val appId: String)

@Serializable
private data class AdminMembersResponse(val members: List<AdminMemberDto> = emptyList())

@Serializable
private data class AdminMemberDto(
    val id: String = "",
    val email: String = "",
    val name: String = "",
    val levelLabel: String = "",
    val role: String = "",
    val fcmRegistered: Boolean = false,
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
                .map { member ->
                    AdminMember(
                        id = member.id,
                        email = member.email,
                        name = member.name,
                        levelLabel = member.levelLabel.ifBlank { "Basic" },
                        role = member.role.ifBlank { "Member" },
                        device = member.fcmRegistered,
                    )
                }
        }
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

    private suspend fun post(path: String, body: String): String {
        val request = request(path).newBuilder()
            .post(body.toRequestBody("application/json; charset=utf-8".toMediaType()))
            .build()
        http.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                throw ProxyException(describe(response.code, text), response.code)
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
