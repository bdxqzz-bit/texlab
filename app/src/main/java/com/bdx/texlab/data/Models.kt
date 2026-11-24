package com.bdx.texlab.data

import kotlinx.serialization.Serializable

/** A file attached to a method, addressed through the proxy (`url` is a proxy-relative path). */
@Serializable
data class PdfAttachment(
    val id: String = "",
    val url: String = "",
    val filename: String? = null,
    val size: Long? = null,
    val type: String? = null,
)

/** One textile test method, as published by the proxy server. */
data class TestMethod(
    /** The method designation, e.g. `ISO 1833-17` (Airtable column `Method`). */
    val id: String,
    val title: String,
    val code: String,
    /** Full title, e.g. "Textiles — Quantitative chemical analysis …" (`Method Name`). */
    val name: String = "",
    /** Edition/year, e.g. `2019` (`Version`). */
    val year: String = "",
    val category: String,
    val summary: String,
    val standard: String,
    val pdf: PdfAttachment?,
) {
    /** Second line on a card: full name, or the scope when the name is missing. */
    val subtitle: String
        get() = name.takeIf { it.isNotBlank() } ?: summary
    val hasPdf: Boolean get() = pdf != null

    val fileName: String
        get() {
            val attached = pdf?.filename?.takeIf { it.isNotBlank() }
            return sanitizeFileName(attached ?: "$title.pdf")
        }

    val sizeLabel: String?
        get() = pdf?.size?.takeIf { it > 0 }?.let { bytes ->
            when {
                bytes >= 1024 * 1024 -> "%.1f MB".format(bytes / (1024f * 1024f))
                else -> "%d KB".format((bytes / 1024).coerceAtLeast(1))
            }
        }
}

/** Membership levels, lowest first. Every new Google account joins at [BASIC]. */
enum class MembershipLevel(val label: String) {
    BASIC("Basic"),
    PRO("Pro"),
    MAX("Max"),
    ;

    companion object {
        /** Unknown or missing values read as Basic, never as a higher level. */
        fun from(raw: String?): MembershipLevel = when (raw?.trim()?.lowercase()) {
            "pro" -> PRO
            "max" -> MAX
            else -> BASIC
        }
    }
}

/**
 * Today's allowance for the signed-in member. The proxy enforces these numbers and returns the
 * counters with every PDF response, so this is only what the UI shows.
 */
data class UsageQuota(
    val level: MembershipLevel,
    val viewsLimit: Int,
    val viewsUsed: Int,
    val downloadsLimit: Int,
    val downloadsUsed: Int,
) {
    val viewsLeft: Int get() = (viewsLimit - viewsUsed).coerceAtLeast(0)
    val downloadsLeft: Int get() = (downloadsLimit - downloadsUsed).coerceAtLeast(0)
    val canView: Boolean get() = viewsLeft > 0
    val canDownload: Boolean get() = downloadsLeft > 0
}

/** Result of asking the proxy for the signed-in Google account's membership. */
sealed interface MembershipResult {
    data class Approved(
        val name: String,
        val role: String,
        val level: MembershipLevel = MembershipLevel.BASIC,
        val firstName: String = "",
        val lastName: String = "",
        val photoUrl: String? = null,
        val quota: UsageQuota? = null,
    ) : MembershipResult

    data object NotAMember : MembershipResult
    data class Failed(val message: String) : MembershipResult
}

/** Roles in the Members table that may use the admin console. Mirrors the Worker's ADMIN_ROLES. */
private val ADMIN_ROLES = setOf("admin", "administrator", "owner", "manager")

fun isAdminRole(role: String?): Boolean {
    val clean = role?.trim()?.lowercase() ?: return false
    return clean in ADMIN_ROLES
}

/**
 * Roles an administrator may assign from the console. Mirrors the Worker's assignable roles;
 * an unknown stored role reads as [MEMBER], which is the least privileged.
 */
enum class AdminRole(val label: String) {
    MEMBER("Member"),
    MANAGER("Manager"),
    ADMIN("Admin"),
    OWNER("Owner"),
    ;

    companion object {
        fun from(raw: String?): AdminRole =
            entries.firstOrNull { it.label.equals(raw?.trim(), ignoreCase = true) } ?: MEMBER
    }
}

/** Membership statuses the console may assign. A row without a status is active. */
enum class MemberStatus(val label: String) {
    ACTIVE("Active"),
    PENDING("Pending"),
    DISABLED("Disabled"),
    ;

    companion object {
        fun from(raw: String?): MemberStatus = when (raw?.trim()?.lowercase()) {
            null, "", "active", "approved", "member", "yes", "true", "1", "paid", "current", "enabled" -> ACTIVE
            "pending" -> PENDING
            else -> DISABLED
        }
    }
}

/** One row in the admin console's member list, and the member detail view. */
data class AdminMember(
    val id: String,
    val email: String,
    val name: String,
    val levelLabel: String,
    val role: String,
    /** The member has turned notifications on and registered a device. */
    val device: Boolean,
    val firstName: String = "",
    val lastName: String = "",
    /** The raw Members Status column (`Active`, `Pending`, `Revoked`, …); blank means active. */
    val status: String = "",
    val photoUrl: String? = null,
    /** The day this device last registered, when the row records it. */
    val registeredAt: String = "",
    val viewsUsed: Int = 0,
    val viewsLimit: Int = 0,
    val downloadsUsed: Int = 0,
    val downloadsLimit: Int = 0,
) {
    val isAdmin: Boolean get() = isAdminRole(role)
    val displayName: String get() = name.takeIf { it.isNotBlank() } ?: email.substringBefore('@')
    val level: MembershipLevel get() = MembershipLevel.from(levelLabel)
    val adminRole: AdminRole get() = AdminRole.from(role)
    val memberStatus: MemberStatus get() = MemberStatus.from(status)
    /** False only when the Status column names something that does not grant access. */
    val active: Boolean get() = memberStatus == MemberStatus.ACTIVE
    val statusLabel: String get() = status.takeIf { it.isNotBlank() } ?: MemberStatus.ACTIVE.label
}

/** One report or request a member sent from inside the app; the admin console lists these. */
data class MemberMessage(
    val id: String,
    val email: String,
    val name: String,
    val kind: String,
    val subject: String,
    val message: String,
    val appVersion: String = "",
    val device: String = "",
    val status: String = "",
    /** ISO timestamp from the Messages row, e.g. `2026-11-24T09:15:00.000Z`. */
    val createdAt: String = "",
) {
    val isRequest: Boolean get() = kind.equals("Request", ignoreCase = true)
    val kindLabel: String get() = kind.trim().ifBlank { "Report" }
    val displayName: String get() = name.takeIf { it.isNotBlank() } ?: email.substringBefore('@')
    val headline: String get() = subject.takeIf { it.isNotBlank() } ?: kindLabel
    val dateLabel: String get() = createdAt.take(10)
}

/** Who an admin notification goes to. */
enum class AdminTarget(val label: String) {
    SELECTED("Selected"),
    EVERYONE("Everyone"),
    ADMINS("Admins"),
    LEVEL("One level"),
}

/** What the proxy reports back after one send. */
data class AdminSendResult(
    val targeted: Int,
    val sent: Int,
    val failed: Int,
    val skipped: List<String>,
    val failures: List<Pair<String, String>>,
) {
    val summary: String
        get() = buildString {
            if (targeted == 0) {
                append("No member with a device matched this target.")
            } else {
                append("$sent of $targeted sent")
            }
            if (failed > 0) append(" \u00b7 $failed failed")
            if (skipped.isNotEmpty()) append(" \u00b7 ${skipped.size} skipped (no device)")
        }
}

internal fun sanitizeFileName(raw: String): String {
    val cleaned = raw.trim().replace(Regex("[\\\\/:*?\"<>|\\r\\n\\t]"), "_").trim('.', ' ')
    val withExtension = if (cleaned.endsWith(".pdf", ignoreCase = true)) cleaned else "$cleaned.pdf"
    return withExtension.take(120).ifBlank { "method.pdf" }
}
