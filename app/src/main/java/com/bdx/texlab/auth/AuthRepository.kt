package com.bdx.texlab.auth

import android.app.Activity
import android.content.Context
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.GoogleAuthProvider
import com.bdx.texlab.data.AppConfig
import kotlinx.coroutines.tasks.await

/**
 * Google sign-in with Credential Manager, exchanged for a Firebase session.
 * Firebase is initialised from local.properties in [com.bdx.texlab.TexLabApplication].
 */
class AuthRepository(private val context: Context) {

    private val credentialManager: CredentialManager = CredentialManager.create(context)

    fun currentUser(): FirebaseUser? =
        if (FirebaseApp.getApps(context).isEmpty()) null else FirebaseAuth.getInstance().currentUser

    suspend fun signInWithGoogle(activity: Activity): Result<FirebaseUser> = runCatching {
        val googleIdOption = GetGoogleIdOption.Builder()
            .setServerClientId(AppConfig.googleWebClientId)
            .setFilterByAuthorizedAccounts(false)
            .setAutoSelectEnabled(false)
            .build()

        val request = GetCredentialRequest.Builder()
            .addCredentialOption(googleIdOption)
            .build()

        val response = credentialManager.getCredential(activity, request)
        val credential = response.credential

        if (credential is CustomCredential &&
            credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
        ) {
            val googleIdToken = try {
                GoogleIdTokenCredential.createFrom(credential.data)
            } catch (error: GoogleIdTokenParsingException) {
                throw IllegalStateException("Google returned an unreadable sign-in token.", error)
            }
            val firebaseCredential = GoogleAuthProvider.getCredential(googleIdToken.idToken, null)
            val auth = FirebaseAuth.getInstance()
            val result = auth.signInWithCredential(firebaseCredential).await()
            result.user ?: throw IllegalStateException("Firebase did not return a user for this Google account.")
        } else {
            throw IllegalStateException("Unsupported sign-in credential type.")
        }
    }

    /**
     * Current Firebase ID token, refreshed by the SDK when it is close to expiry.
     * This is what the proxy server verifies on every request.
     */
    suspend fun idToken(forceRefresh: Boolean = false): String? {
        if (FirebaseApp.getApps(context).isEmpty()) return null
        val user = FirebaseAuth.getInstance().currentUser ?: return null
        return runCatching { user.getIdToken(forceRefresh).await()?.token }.getOrNull()
    }

    fun signOut() {
        if (FirebaseApp.getApps(context).isNotEmpty()) {
            FirebaseAuth.getInstance().signOut()
        }
    }
}

/** Turns Credential Manager / Firebase failures into something a lab technician can act on. */
fun Throwable.friendlyAuthMessage(): String = when (this) {
    is GetCredentialCancellationException -> "Sign-in cancelled."
    is NoCredentialException -> "No Google account is available on this device. Add one in Android settings and try again."
    is GetCredentialException -> message ?: "Google sign-in could not start. Check Play services and try again."
    else -> message ?: "Sign-in failed. Please try again."
}
