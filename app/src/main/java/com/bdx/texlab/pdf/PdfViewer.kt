package com.bdx.texlab.pdf

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.roundToInt

/** Zoom is a multiplier on the page width: 1 = fit the viewport, >1 = larger with horizontal panning. */
private const val DEFAULT_ZOOM = 1.0f
private const val MIN_ZOOM = 0.5f
private const val MAX_ZOOM = 5.0f
private const val ZOOM_STEP = 0.25f

/** Gap around and between pages, also reserved on both sides when computing fit-width pages. */
private val PAGE_GUTTER = 12.dp

/** Fallback page aspect ratio (width / height) used until the renderer reports the real size. */
private const val DEFAULT_PAGE_RATIO = 0.7071f

/**
 * Scrollable, lazily rendered PDF pages. Uses the platform renderer, so no extra SDK is needed.
 *
 * [zoomFactor] is owned by the caller and scaled relative to the viewport: 1 renders pages at
 * fit-width, larger values enlarge the page (pan horizontally to see the rest), smaller values
 * shrink it. It is clamped to [MIN_ZOOM]..[MAX_ZOOM]; non-finite inputs fall back to 1.
 *
 * When [onZoomChange] is supplied, floating zoom in/out/reset controls are shown. Each button
 * reports the new value through the callback, keeping the state hoisted at the call site.
 */
@Composable
fun PdfViewer(
    file: File,
    modifier: Modifier = Modifier,
    zoomFactor: Float = DEFAULT_ZOOM,
    onZoomChange: ((Float) -> Unit)? = null,
) {
    var document by remember(file.path) { mutableStateOf<PdfDocument?>(null) }
    var error by remember(file.path) { mutableStateOf<String?>(null) }
    val zoom = normalizeZoom(zoomFactor)
    // One scroll state for the whole column, so every page pans together and stays aligned.
    val horizontalScroll = rememberScrollState()

    LaunchedEffect(file.path) {
        error = null
        withContext(Dispatchers.IO) { runCatching { PdfDocument.open(file) } }
            .onSuccess { document = it }
            .onFailure { error = it.message ?: "This PDF could not be opened." }
    }

    DisposableEffect(document) {
        val open = document
        onDispose { open?.close() }
    }

    val currentError = error
    Box(modifier = modifier.fillMaxSize()) {
        when {
            currentError != null -> Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
                Text(
                    text = currentError,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                    textAlign = TextAlign.Center,
                )
            }

            document == null -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }

            document?.pageCount == 0 -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("This PDF has no pages.")
            }

            else -> document?.let { pdf ->
                BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
                    val pageWidth = (maxWidth - PAGE_GUTTER * 2) * zoom
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .horizontalScroll(horizontalScroll),
                    ) {
                        LazyColumn(
                            modifier = Modifier
                                .width(pageWidth + PAGE_GUTTER * 2)
                                .fillMaxHeight(),
                            contentPadding = PaddingValues(PAGE_GUTTER),
                            verticalArrangement = Arrangement.spacedBy(PAGE_GUTTER),
                        ) {
                            items(pdf.pageCount) { pageIndex ->
                                PdfPage(pdf, pageIndex, pageWidth)
                            }
                        }
                    }
                }
            }
        }

        if (onZoomChange != null) {
            ZoomControls(
                zoomFactor = zoom,
                onZoomIn = { onZoomChange(stepZoom(zoom, +1)) },
                onZoomOut = { onZoomChange(stepZoom(zoom, -1)) },
                onReset = { onZoomChange(DEFAULT_ZOOM) },
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(16.dp),
            )
        }
    }
}

@Composable
private fun ZoomControls(
    zoomFactor: Float,
    onZoomIn: () -> Unit,
    onZoomOut: () -> Unit,
    onReset: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(24.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
        shadowElevation = 4.dp,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.padding(horizontal = 4.dp),
        ) {
            IconButton(onClick = onZoomOut, enabled = zoomFactor > MIN_ZOOM) {
                Text("−", style = MaterialTheme.typography.titleLarge)
            }
            TextButton(onClick = onReset, enabled = zoomFactor != DEFAULT_ZOOM) {
                Text("${(zoomFactor * 100).roundToInt()}%")
            }
            IconButton(onClick = onZoomIn, enabled = zoomFactor < MAX_ZOOM) {
                Text("+", style = MaterialTheme.typography.titleLarge)
            }
        }
    }
}

@Composable
private fun PdfPage(document: PdfDocument, index: Int, pageWidth: Dp) {
    var ratio by remember(document, index) { mutableStateOf(DEFAULT_PAGE_RATIO) }
    var bitmap by remember(document, index) { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember(document, index) { mutableStateOf(false) }
    val density = LocalDensity.current

    Box(
        modifier = Modifier
            .width(pageWidth)
            .aspectRatio(ratio)
            .clip(RoundedCornerShape(8.dp))
            .background(Color.White),
    ) {
        LaunchedEffect(index, pageWidth) {
            // Render at the laid-out width so zoomed-in pages stay crisp.
            val targetWidthPx = with(density) { pageWidth.roundToPx() }
            if (targetWidthPx <= 0) return@LaunchedEffect
            runCatching { document.pageSize(index) }.onSuccess { size ->
                if (size.width > 0 && size.height > 0) {
                    ratio = size.width.toFloat() / size.height
                }
            }
            runCatching { document.renderPage(index, targetWidthPx) }
                .onSuccess { bitmap = it.asImageBitmap() }
                .onFailure { failed = true }
        }

        val image = bitmap
        if (image != null) {
            Image(
                bitmap = image,
                contentDescription = "Page ${index + 1}",
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Fit,
            )
        } else {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                if (failed) {
                    Text(
                        text = "Page ${index + 1} could not be rendered.",
                        style = MaterialTheme.typography.bodySmall,
                        color = Color.Gray,
                    )
                } else {
                    CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                }
            }
        }
    }
}

/** Steps [current] by one [ZOOM_STEP] in [direction] (+1 in, -1 out), clamped to the zoom range. */
private fun stepZoom(current: Float, direction: Int): Float =
    normalizeZoom(current + direction * ZOOM_STEP)

private fun normalizeZoom(zoomFactor: Float): Float =
    if (zoomFactor.isFinite()) zoomFactor.coerceIn(MIN_ZOOM, MAX_ZOOM) else DEFAULT_ZOOM
