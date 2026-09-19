# The watch app is small and has no reflection of its own; these keep the bits
# that other code reaches by name.
-keep class com.notetrace.app.wear.PairingService { *; }
-keep class com.notetrace.app.wear.ListTileService { *; }
-keep class com.notetrace.app.wear.ListComplicationService { *; }
-dontwarn org.slf4j.**
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
