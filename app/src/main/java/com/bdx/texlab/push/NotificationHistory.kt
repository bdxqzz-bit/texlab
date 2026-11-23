package com.bdx.texlab.push

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject

/** One message the console sent and this device received. */
data class PushMessage(
    val id: Long,
    val title: String,
    val body: String,
    val receivedAt: Long,
)

/**
 * The member's own history of the pushes this device received, newest first.
 *
 * It lives on the device only (SharedPreferences) and is capped at [MAX_ITEMS]; the proxy is never
 * asked for it. [unseenCount] drives the badge on the bell on the home screen and drops back to
 * zero when the member opens the history.
 */
object NotificationHistory {

    private const val FILE = "texlab_notifications"
    private const val KEY_ITEMS = "items"
    private const val KEY_LAST_SEEN = "last_seen"
    private const val MAX_ITEMS = 100

    /** A redelivery of the same message inside this window does not add a second entry. */
    private const val DUPLICATE_WINDOW_MS = 5 * 60 * 1000L

    private val _items = MutableStateFlow<List<PushMessage>>(emptyList())
    val items: StateFlow<List<PushMessage>> = _items.asStateFlow()

    private val _unseen = MutableStateFlow(0)
    val unseenCount: StateFlow<Int> = _unseen.asStateFlow()

    private var loaded = false
    private var lastSeenAt = 0L

    @Synchronized
    fun ensureLoaded(context: Context) {
        if (loaded) return
        loaded = true
        val prefs = prefs(context)
        lastSeenAt = prefs.getLong(KEY_LAST_SEEN, 0L)
        val stored = prefs.getString(KEY_ITEMS, null) ?: return
        _items.value = runCatching {
            val array = JSONArray(stored)
            buildList {
                for (index in 0 until array.length()) {
                    val row = array.optJSONObject(index) ?: continue
                    add(
                        PushMessage(
                            id = row.optLong("id"),
                            title = row.optString("title"),
                            body = row.optString("body"),
                            receivedAt = row.optLong("receivedAt"),
                        ),
                    )
                }
            }
        }.getOrDefault(emptyList())
        refreshUnseen()
    }

    /** Records one received message; called by the FCM service and when a notification is tapped. */
    @Synchronized
    fun record(
        context: Context,
        title: String,
        body: String,
        receivedAt: Long = System.currentTimeMillis(),
    ) {
        ensureLoaded(context)
        if (title.isBlank() && body.isBlank()) return
        val id = messageId(title, body)
        val newest = _items.value.firstOrNull()
        if (newest != null && newest.id == id && receivedAt - newest.receivedAt < DUPLICATE_WINDOW_MS) {
            return
        }
        val next = (listOf(PushMessage(id, title, body, receivedAt)) + _items.value).take(MAX_ITEMS)
        _items.value = next
        persist(context, next)
        refreshUnseen()
    }

    /** The member has looked at the history, so the bell badge goes away. */
    @Synchronized
    fun markSeen(context: Context) {
        ensureLoaded(context)
        lastSeenAt = System.currentTimeMillis()
        prefs(context).edit().putLong(KEY_LAST_SEEN, lastSeenAt).apply()
        _unseen.value = 0
    }

    @Synchronized
    fun clear(context: Context) {
        ensureLoaded(context)
        _items.value = emptyList()
        _unseen.value = 0
        persist(context, emptyList())
    }

    private fun refreshUnseen() {
        _unseen.value = _items.value.count { it.receivedAt > lastSeenAt }
    }

    private fun persist(context: Context, messages: List<PushMessage>) {
        val array = JSONArray()
        messages.forEach { message ->
            array.put(
                JSONObject()
                    .put("id", message.id)
                    .put("title", message.title)
                    .put("body", message.body)
                    .put("receivedAt", message.receivedAt),
            )
        }
        prefs(context).edit().putString(KEY_ITEMS, array.toString()).apply()
    }

    private fun messageId(title: String, body: String): Long =
        "$title\u0000$body".hashCode().toLong()

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
}
