package com.bdx.texlab.pdf

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** Scrollable, lazily rendered PDF pages. Uses the platform renderer, so no extra SDK is needed. */
@Composable
fun PdfViewer(file: File, modifier: Modifier = Modifier) {
    var document by remember(file.path) { mutableStateOf<PdfDocument?>(null) }
    var error by remember(file.path) { mutableStateOf<String?>(null) }

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
    when {
        currentError != null -> Box(modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
            Text(
                text = currentError,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
                textAlign = TextAlign.Center,
            )
        }

        document == null -> Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }

        document?.pageCount == 0 -> Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("This PDF has no pages.")
        }

        else -> document?.let { pdf ->
            LazyColumn(
                modifier = modifier.fillMaxSize(),
                contentPadding = PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(pdf.pageCount) { pageIndex ->
                    PdfPage(pdf, pageIndex)
                }
            }
        }
    }
}

@Composable
private fun PdfPage(document: PdfDocument, index: Int) {
    var ratio by remember(document, index) { mutableStateOf(0.7071f) }
    var bitmap by remember(document, index) { mutableStateOf<ImageBitmap?>(null) }
    var failed by remember(document, index) { mutableStateOf(false) }
    val density = LocalDensity.current

    BoxWithConstraints(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(ratio)
            .clip(RoundedCornerShape(8.dp))
            .background(Color.White),
    ) {
        val width = maxWidth
        LaunchedEffect(index, width) {
            val targetWidthPx = with(density) { width.roundToPx() }
            if (targetWidthPx <= 0) return@LaunchedEffect
            runCatching { document.pageSize(index) }.onSuccess { size ->
                if (size.width > 0 && size.height > 0) ratio = size.width.toFloat() / size.height
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
