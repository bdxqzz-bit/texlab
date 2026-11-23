package com.bdx.texlab.pdf

import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.ui.unit.IntSize
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.Closeable
import java.io.File

/**
 * Thread-safe wrapper around [PdfRenderer]. PdfRenderer is not thread-safe, so every
 * open/render call is serialised through a single mutex.
 */
class PdfDocument private constructor(
    private val descriptor: ParcelFileDescriptor,
    private val renderer: PdfRenderer,
) : Closeable {

    private val mutex = Mutex()
    private val pageSizes = mutableMapOf<Int, IntSize>()

    val pageCount: Int get() = renderer.pageCount

    suspend fun pageSize(index: Int): IntSize = mutex.withLock {
        withContext(Dispatchers.IO) {
            pageSizes.getOrPut(index) {
                val page = renderer.openPage(index)
                try {
                    IntSize(page.width, page.height)
                } finally {
                    page.close()
                }
            }
        }
    }

    suspend fun renderPage(index: Int, targetWidthPx: Int): android.graphics.Bitmap = mutex.withLock {
        withContext(Dispatchers.IO) {
            val page = renderer.openPage(index)
            try {
                val width = targetWidthPx.coerceIn(320, 2400)
                val height = (page.height.toFloat() * width / page.width.toFloat()).toInt().coerceAtLeast(1)
                val bitmap = android.graphics.Bitmap.createBitmap(width, height, android.graphics.Bitmap.Config.ARGB_8888)
                bitmap.eraseColor(android.graphics.Color.WHITE)
                page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                bitmap
            } finally {
                page.close()
            }
        }
    }

    override fun close() {
        runCatching { renderer.close() }
        runCatching { descriptor.close() }
    }

    companion object {
        fun open(file: File): PdfDocument {
            val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
            return try {
                PdfDocument(descriptor, PdfRenderer(descriptor))
            } catch (error: Throwable) {
                runCatching { descriptor.close() }
                throw error
            }
        }
    }
}
