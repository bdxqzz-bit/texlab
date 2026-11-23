package com.bdx.texlab

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import com.bdx.texlab.push.NotificationHistory
import com.bdx.texlab.ui.AppViewModel
import com.bdx.texlab.ui.TexLabApp
import com.bdx.texlab.ui.theme.TexLabTheme

class MainActivity : ComponentActivity() {

    private val viewModel: AppViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        recordTappedNotification(intent)
        setContent {
            TexLabTheme {
                TexLabApp(viewModel = viewModel, activity = this)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        recordTappedNotification(intent)
    }

    /**
     * A push drawn by the system while TexLab was in the background is not seen by
     * [com.bdx.texlab.push.TexLabMessagingService]; its data comes back with the launch intent, so
     * opening it puts the message in the home screen's history too.
     */
    private fun recordTappedNotification(intent: Intent?) {
        val extras = intent?.extras ?: return
        val title = extras.getString("title").orEmpty()
        val body = extras.getString("body").orEmpty()
        if (title.isBlank() && body.isBlank()) return
        NotificationHistory.record(this, title, body)
    }
}
