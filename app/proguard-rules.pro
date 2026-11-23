# Keep Credential Manager / Google ID classes used reflectively by the Play services provider
-keep class com.google.android.libraries.identity.googleid.** { *; }
-keep class androidx.credentials.** { *; }

# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class kotlinx.serialization.json.** { *; }
-keep,includedescriptorclasses class com.texlab.methods.**$$serializer { *; }
-keepclassmembers class com.texlab.methods.** { *** Companion; }
