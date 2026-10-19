plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "cz.orbit.quest"
    compileSdk = 35

    defaultConfig {
        applicationId = "cz.orbit.quest"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation("io.github.webrtc-sdk:android:125.6422.07")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
