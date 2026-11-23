package com.bdx.texlab.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val DeepInk = Color(0xFF0E2A38)
private val DyeTeal = Color(0xFF1F6F63)
private val PaleMint = Color(0xFFBFE4DA)
private val Clay = Color(0xFF9A5B33)

private val LightColors = lightColorScheme(
    primary = DyeTeal,
    onPrimary = Color.White,
    primaryContainer = PaleMint,
    onPrimaryContainer = DeepInk,
    secondary = Clay,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFF6DFCE),
    onSecondaryContainer = Color(0xFF3A1E0C),
    background = Color(0xFFF6FAF8),
    onBackground = DeepInk,
    surface = Color.White,
    onSurface = DeepInk,
    surfaceVariant = Color(0xFFE4EBE9),
    onSurfaceVariant = Color(0xFF44534F),
    outline = Color(0xFF9DA9A5),
    error = Color(0xFFB3261E),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF7FD3C2),
    onPrimary = Color(0xFF00382F),
    primaryContainer = Color(0xFF0B4A40),
    onPrimaryContainer = PaleMint,
    secondary = Color(0xFFE9B58F),
    onSecondary = Color(0xFF48280F),
    background = Color(0xFF0B1512),
    onBackground = Color(0xFFDCE5E2),
    surface = Color(0xFF11201C),
    onSurface = Color(0xFFDCE5E2),
    surfaceVariant = Color(0xFF24332E),
    onSurfaceVariant = Color(0xFFB8C6C1),
    error = Color(0xFFFFB4AB),
)

@Composable
fun TexLabTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = Typography(),
        content = content,
    )
}
