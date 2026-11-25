package com.bdx.texlab.pdf

import android.content.Context
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintDocumentInfo
import android.print.PrintManager
import java.io.File

/**
 * Hands an already-loaded PDF to Android's print framework, so a member can print straight from
 * the viewer without saving a copy to Downloads first. Printing a PDF this way is supported by
 * the platform's PDF print service from Android 5.0 on.
 */
fun printPdf(context: Context, file: File, jobName: String) {
    val manager = context.getSystemService(Context.PRINT_SERVICE) as? PrintManager ?: return
    val name = jobName.trim().ifBlank { "Test method" }
    manager.print(name, PdfPrintAdapter(file, name), PrintAttributes.Builder().build())
}

private class PdfPrintAdapter(
    private val file: File,
    private val jobName: String,
) : PrintDocumentAdapter() {

    override fun onLayout(
        oldAttributes: PrintAttributes?,
        newAttributes: PrintAttributes?,
        cancellationSignal: CancellationSignal?,
        callback: LayoutResultCallback,
        extras: Bundle?,
    ) {
        if (cancellationSignal?.isCanceled == true) {
            callback.onLayoutCancelled()
            return
        }
        val info = PrintDocumentInfo.Builder(file.name.ifBlank { "$jobName.pdf" })
            .setContentType(PrintDocumentInfo.CONTENT_TYPE_DOCUMENT)
            .setPageCount(PrintDocumentInfo.PAGE_COUNT_UNKNOWN)
            .build()
        callback.onLayoutFinished(info, true)
    }

    override fun onWrite(
        pages: Array<out PageRange>?,
        destination: ParcelFileDescriptor?,
        cancellationSignal: CancellationSignal?,
        callback: WriteResultCallback,
    ) {
        val target = destination
        if (target == null) {
            callback.onWriteFailed("The printer could not open the document.")
            return
        }
        try {
            ParcelFileDescriptor.AutoCloseOutputStream(target).use { output ->
                file.inputStream().use { input -> input.copyTo(output) }
            }
            callback.onWriteFinished(arrayOf(PageRange.ALL_PAGES))
        } catch (error: Throwable) {
            callback.onWriteFailed(error.message ?: "The PDF could not be prepared for printing.")
        }
    }
}
