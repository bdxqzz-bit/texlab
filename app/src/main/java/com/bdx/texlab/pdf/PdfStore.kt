package com.bdx.texlab.pdf

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import com.bdx.texlab.data.FileMode
import com.bdx.texlab.data.ProxyClient
import com.bdx.texlab.data.TestMethod
import com.bdx.texlab.data.UsageQuota
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

data class SavedLocation(val uri: String, val displayPath: String)

/** A PDF fetched for viewing, plus today's counters as the proxy reported them. */
data class ViewedPdf(val file: File, val quota: UsageQuota?)

/**
 * Owns PDF files: one cache entry per viewed method, plus export to Downloads.
 *
 * Every fetch goes through the proxy, which charges one view or one download against the
 * member's daily allowance, so a cached file is not a way around the limit: viewing always
 * re-fetches as a view. Printing is charged as a download, but it prints the copy already
 * cached for viewing instead of fetching the PDF again.
 */
class PdfStore(
    private val context: Context,
    private val client: ProxyClient,
) {
    private val cacheDir: File
        get() = File(context.cacheDir, "pdfs").apply { mkdirs() }

    /** Opens a PDF for viewing; the proxy counts one view for this. */
    suspend fun fetchForView(method: TestMethod, onProgress: (Float) -> Unit = {}): ViewedPdf =
        withContext(Dispatchers.IO) {
            val attachment = method.pdf
                ?: throw IllegalStateException("This method has no PDF attached.")
            val target = File(cacheDir, "view-${method.id}.pdf")
            val partial = File(cacheDir, "view-${method.id}.part")
            if (partial.exists()) partial.delete()

            val quota = client.download(attachment.url, partial, FileMode.VIEW, onProgress)

            if (!partial.renameTo(target)) {
                partial.copyTo(target, overwrite = true)
                partial.delete()
            }
            ViewedPdf(target, quota)
        }

    /** Saves a PDF to the phone's Downloads; the proxy counts one download for this. */
    suspend fun downloadToDevice(
        method: TestMethod,
        onProgress: (Float) -> Unit = {},
    ): Pair<SavedLocation, UsageQuota?> =
        withContext(Dispatchers.IO) {
            val attachment = method.pdf
                ?: throw IllegalStateException("This method has no PDF attached.")
            val temp = File(cacheDir, "download-${method.id}.part")
            if (temp.exists()) temp.delete()
            val quota = client.download(attachment.url, temp, FileMode.DOWNLOAD, onProgress)
            try {
                exportToDownloads(temp, method.fileName) to quota
            } finally {
                temp.delete()
            }
        }

    /**
     * Charges the download printing costs, without fetching the PDF again: the viewer prints the
     * copy it already opened, so only the quota changes.
     */
    suspend fun markPrinted(method: TestMethod): UsageQuota? =
        withContext(Dispatchers.IO) {
            val attachment = method.pdf
                ?: throw IllegalStateException("This method has no PDF attached.")
            client.chargePrint(attachment.url)
        }

    private suspend fun exportToDownloads(source: File, displayName: String): SavedLocation =
        withContext(Dispatchers.IO) {
            val fileName = displayName.takeIf { it.isNotBlank() } ?: "method.pdf"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val relativePath = "${Environment.DIRECTORY_DOWNLOADS}/TexLab"
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                    put(MediaStore.Downloads.MIME_TYPE, "application/pdf")
                    put(MediaStore.Downloads.RELATIVE_PATH, relativePath)
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = context.contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("Could not create a file in Downloads.")
                try {
                    resolver.openOutputStream(uri)?.use { output ->
                        source.inputStream().use { input -> input.copyTo(output) }
                    } ?: throw IllegalStateException("Could not write to Downloads.")
                    val done = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
                    resolver.update(uri, done, null, null)
                    SavedLocation(uri.toString(), "Downloads/TexLab/$fileName")
                } catch (error: Throwable) {
                    resolver.delete(uri, null, null)
                    throw error
                }
            } else {
                @Suppress("DEPRECATION")
                val root = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
                    ?: context.filesDir
                val folder = File(root, "TexLab").apply { mkdirs() }
                val target = File(folder, fileName)
                source.copyTo(target, overwrite = true)
                SavedLocation(Uri.fromFile(target).toString(), target.absolutePath)
            }
        }

    fun clearCache() {
        cacheDir.listFiles()?.forEach { it.delete() }
    }
}

/** Share sheet entry for a cached PDF (FileProvider authority is declared in the manifest). */
fun pdfShareIntent(context: Context, file: File, title: String): Intent {
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
    return Intent(Intent.ACTION_SEND).apply {
        type = "application/pdf"
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_SUBJECT, title)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
}
