package com.bdx.texlab.ui.screens

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.bdx.texlab.BuildConfig
import com.bdx.texlab.data.TestMethod
import com.bdx.texlab.pdf.PdfViewer
import com.bdx.texlab.pdf.pdfShareIntent
import java.io.File

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ViewerScreen(
    method: TestMethod?,
    onBack: () -> Unit,
    onDownload: (TestMethod) -> Unit,
    preparePdf: suspend (TestMethod, (Float) -> Unit) -> File,
) {
    val context = LocalContext.current
    var file by remember(method?.id) { mutableStateOf<File?>(null) }
    var progress by remember(method?.id) { mutableStateOf<Float?>(null) }
    var error by remember(method?.id) { mutableStateOf<String?>(null) }
    var attempt by remember(method?.id) { mutableStateOf(0) }
    var zoomFactor by remember(method?.id) { mutableStateOf(1.0f) }

    LaunchedEffect(method?.id, attempt) {
        val target = method ?: return@LaunchedEffect
        file = null
        error = null
        progress = 0f
        runCatching { preparePdf(target) { value -> progress = value } }
            .onSuccess {
                file = it
                progress = null
            }
            .onFailure {
                error = it.message ?: "Could not open this PDF."
                progress = null
            }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                title = {
                    Column {
                        Text(
                            text = method?.title ?: "Test method",
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        method?.let { details ->
                            val subtitle = listOf(details.code, details.category)
                                .filter { it.isNotBlank() }
                                .joinToString(" · ")
                            if (subtitle.isNotBlank()) {
                                Text(text = subtitle, style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                },
                actions = {
                    val openFile = file
                    IconButton(
                        onClick = {
                            if (openFile != null) {
                                context.startActivity(
                                    Intent.createChooser(
                                        pdfShareIntent(context, openFile, method?.title ?: "Test method"),
                                        "Share PDF",
                                    )
                                )
                            }
                        },
                        enabled = openFile != null,
                    ) {
                        Icon(Icons.Filled.Share, contentDescription = "Share PDF")
                    }
                    IconButton(
                        onClick = { method?.let(onDownload) },
                        enabled = method?.hasPdf == true,
                    ) {
                        Icon(Icons.Filled.Download, contentDescription = "Download PDF")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    titleContentColor = MaterialTheme.colorScheme.onPrimary,
                    navigationIconContentColor = MaterialTheme.colorScheme.onPrimary,
                    actionIconContentColor = MaterialTheme.colorScheme.onPrimary,
                ),
            )
        },
    ) { padding ->
        Box(modifier = Modifier.padding(padding).fillMaxSize()) {
            val openFile = file
            val failure = error
            when {
                method == null -> CenteredText("This test method is no longer in the library.")
                failure != null -> Column(
                    modifier = Modifier.fillMaxSize().padding(32.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    Text(
                        text = failure,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                        textAlign = TextAlign.Center,
                    )
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = { attempt++ }) { Text("Retry") }
                }

                openFile != null -> PdfViewer(
                    file = openFile,
                    modifier = Modifier.fillMaxSize(),
                    zoomFactor = zoomFactor,
                    onZoomChange = { zoomFactor = it },
                )
                method?.hasPdf != true -> CenteredText("This method has no PDF attached.")
                else -> Column(
                    modifier = Modifier.fillMaxSize(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(32.dp), strokeWidth = 3.dp)
                    Spacer(Modifier.height(12.dp))
                    Text(
                        text = progress?.let { "Downloading ${(it * 100).toInt()}%" } ?: "Downloading PDF…",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun CenteredText(text: String) {
    Box(modifier = Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
fun SetupScreen(problems: List<String>) {
    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(24.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(
                imageVector = Icons.Filled.Build,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(36.dp),
            )
            Spacer(Modifier.height(12.dp))
            Text(
                text = "Configuration needed",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                text = "Fix the settings below, then rebuild and reinstall the app. " +
                    "see README.md for where each value comes from.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(16.dp))
            problems.forEach { problem ->
                Card(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Text(
                        text = problem,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }
            Spacer(Modifier.height(16.dp))
            Text(
                text = "Firebase: app/google-services.json (package ${BuildConfig.APPLICATION_ID}) with " +
                    "the Google provider enabled in Authentication.\n" +
                    "Method server: PROXY_BASE_URL in local.properties, pointing at the proxy " +
                    "that keeps the Airtable token server-side (see README.md).",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
