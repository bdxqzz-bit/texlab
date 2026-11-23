package com.bdx.texlab

import android.app.Application
import com.bdx.texlab.data.AppConfig
import com.bdx.texlab.push.NotificationHistory
import com.bdx.texlab.push.PushNotifications

class TexLabApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        AppConfig.init(this)
        // The channel exists before the first console message arrives.
        PushNotifications.ensureChannel(this)
        // Loads the bell's history before the first screen composes.
        NotificationHistory.ensureLoaded(this)
    }
}
