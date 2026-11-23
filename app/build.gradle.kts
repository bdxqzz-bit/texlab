import java.io.File
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.google.services)
}

// Firebase is configured by app/google-services.json (read by the google-services plugin).
// The app carries no Airtable credentials: it talks to the proxy server named by
// PROXY_BASE_URL, which holds the Airtable token and verifies Firebase ID tokens. See README.md.
// local.properties is untracked; values can also come from environment variables.
val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

fun config(key: String, fallback: String = ""): String =
    localProperties.getProperty(key) ?: System.getenv(key) ?: fallback

fun quoted(value: String): String = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

// Release signing. The keystore and its password stay out of git (see .gitignore); the values come
// from local.properties or the environment when CI builds the APK.
val releaseStoreFile = config("RELEASE_STORE_FILE")
val releaseStorePassword = config("RELEASE_STORE_PASSWORD")
val releaseKeyAlias = config("RELEASE_KEY_ALIAS")
val releaseKeyPassword = config("RELEASE_KEY_PASSWORD")
val hasReleaseSigning = releaseStoreFile.isNotEmpty() && releaseStorePassword.isNotEmpty() &&
    releaseKeyAlias.isNotEmpty() && releaseKeyPassword.isNotEmpty()

android {
    namespace = "com.bdx.texlab"
    compileSdk = 35

    defaultConfig {
        // Must match the android_client_info.package_name in app/google-services.json.
        applicationId = "com.bdx.texlab"
        minSdk = 26
        targetSdk = 35
        // Bump both for every published build: the proxy's /api/app/latest compares against them.
        versionCode = 4
        versionName = "1.12"

        // Optional override: normally read from google-services.json (default_web_client_id).
        buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", quoted(config("GOOGLE_WEB_CLIENT_ID")))

        // Method server. Airtable is only reachable through it (see server/index.mjs).
        buildConfigField("String", "PROXY_BASE_URL", quoted(config("PROXY_BASE_URL")))
        buildConfigField("String", "SUPPORT_EMAIL", quoted(config("SUPPORT_EMAIL", "labs@example.com")))
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = rootProject.file(releaseStoreFile)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Without these values the release build stays unsigned rather than failing the build;
            // never publish an unsigned APK (Android refuses to install it).
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
        }
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

// Every build leaves its APK in the project root as well, so the installable file is easy to find.
fun apkCopy(variant: String) = tasks.register("copy${variant}ApkToRoot") {
    group = "build"
    description = "Copies the $variant APK into the project root."
    val apkDir = layout.buildDirectory.dir("outputs/apk/${variant.lowercase()}")
    val rootDir = rootProject.layout.projectDirectory.asFile
    dependsOn("package$variant")
    doLast {
        val copied = apkDir.get().asFile
            .listFiles { file -> file.isFile && file.extension.equals("apk", ignoreCase = true) }
            .orEmpty()
            .map { apk ->
                apk.copyTo(File(rootDir, apk.name), overwrite = true)
                apk.name
            }
        if (copied.isNotEmpty()) println("APK copied to project root: ${copied.joinToString()}")
    }
}

val copyDebugApkToRoot = apkCopy("Debug")
val copyReleaseApkToRoot = apkCopy("Release")

tasks.matching { it.name == "assembleDebug" }.configureEach { finalizedBy(copyDebugApkToRoot) }
tasks.matching { it.name == "assembleRelease" }.configureEach { finalizedBy(copyReleaseApkToRoot) }

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.navigation.compose)
    debugImplementation(libs.androidx.compose.ui.tooling)

    // Google sign-in (Credential Manager) + Firebase Authentication
    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play.services)
    implementation(libs.googleid)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.auth)
    // Push notifications from the admin console (FCM). The device token is registered against the
    // signed-in member through the proxy, so the Worker knows which row to deliver to.
    implementation(libs.firebase.messaging)
    implementation(libs.kotlinx.coroutines.play.services)

    // Airtable REST + JSON
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
}
