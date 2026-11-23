package com.bdx.texlab.ui.screens

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request

private val avatarHttp by lazy { OkHttpClient() }

/**
 * The Google profile photo the proxy copied into the Members table, with the member's initial as
 * the fallback while it loads, when the account has no picture, or when the device is offline.
 */
@Composable
internal fun MemberAvatar(
    photoUrl: String?,
    initials: String,
    modifier: Modifier = Modifier,
    size: Dp = 36.dp,
    fallbackColor: Color = MaterialTheme.colorScheme.primaryContainer,
    fallbackContentColor: Color = MaterialTheme.colorScheme.onPrimaryContainer,
) {
    var bitmap by remember(photoUrl) { mutableStateOf<ImageBitmap?>(null) }

    LaunchedEffect(photoUrl) {
        val url = photoUrl?.takeIf { it.startsWith("http") }
        if (url == null) {
            bitmap = null
            return@LaunchedEffect
        }
        bitmap = runCatching {
            withContext(Dispatchers.IO) {
                avatarHttp.newCall(Request.Builder().url(url).build()).execute().use { response ->
                    if (!response.isSuccessful) return@use null
                    response.body?.byteStream()?.let { stream ->
                        BitmapFactory.decodeStream(stream)?.asImageBitmap()
                    }
                }
            }
        }.getOrNull()
    }

    val image = bitmap
    if (image != null) {
        Image(
            bitmap = image,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = modifier.size(size).clip(CircleShape),
        )
    } else {
        Surface(
            shape = CircleShape,
            color = fallbackColor,
            contentColor = fallbackContentColor,
            modifier = modifier.size(size),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Text(
                    text = initials.trim().take(1).uppercase().ifBlank { "M" },
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }
    }
}
