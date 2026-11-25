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
        versionCode = providers.gradleProperty("orbitVersionCode").orElse("1").get().toInt()
        versionName = providers.gradleProperty("orbitVersion").orElse("0.1.0").get()
    }
    val releaseSigningConfigured = listOf(
        System.getenv("ORBIT_KEYSTORE"),
        System.getenv("ORBIT_KEYSTORE_PASSWORD"),
        System.getenv("ORBIT_KEY_PASSWORD"),
    ).all { !it.isNullOrBlank() }

    signingConfigs {
        if (releaseSigningConfigured) {
            create("release") {
                storeFile = file(System.getenv("ORBIT_KEYSTORE"))
                storePassword = System.getenv("ORBIT_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ORBIT_KEY_ALIAS") ?: "orbit-agent"
                keyPassword = System.getenv("ORBIT_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            if (releaseSigningConfigured) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
    lint {
        checkReleaseBuilds = false
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation("io.github.webrtc-sdk:android:125.6422.07")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
