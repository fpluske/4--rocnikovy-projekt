./gradlew :app:assembleDebug :setup:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb install -r setup/build/outputs/apk/debug/setup-debug.apk 
adb shell dpm set-device-owner   cz.orbit.quest/.OrbitDeviceAdminReceiver
adb shell dpm list-owners
adb reboot