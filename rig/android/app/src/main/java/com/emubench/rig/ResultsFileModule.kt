package com.emubench.rig

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

/**
 * Minimal native module backing the rig's results writer and startup
 * marker (SPEC.md §9). Registered as a legacy bridge module (works under
 * the New Architecture's bridge interop layer, no Codegen needed) rather
 * than pulling in a filesystem dependency -- D6 (SPEC.md §2) pins the rig's
 * dependency list closed.
 */
class ResultsFileModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "ResultsFile"

  /**
   * Absolute path to the app's documents-equivalent directory on Android
   * (files dir), mirroring iOS's NSDocumentDirectory so both platforms
   * write `embench-results.json` to a directory the host can pull with
   * `adb pull`.
   */
  @ReactMethod
  fun getDocumentsPath(promise: Promise) {
    promise.resolve(reactApplicationContext.filesDir.absolutePath)
  }

  /**
   * Writes `contents` to `<documentsPath>/<filename>`, creating parent
   * directories if needed. Overwrites any existing file.
   */
  @ReactMethod
  fun writeFile(filename: String, contents: String, promise: Promise) {
    try {
      val dir = reactApplicationContext.filesDir
      if (!dir.exists()) dir.mkdirs()
      val file = File(dir, filename)
      file.writeText(contents)
      promise.resolve(file.absolutePath)
    } catch (e: Exception) {
      promise.reject("results_file_write_error", e.message, e)
    }
  }

  /**
   * Native process-start timestamp (epoch ms), captured as early as
   * possible -- `Process.getStartUptimeMillis()` on API 24+ converted to
   * epoch time via the elapsed-realtime offset. Feeds the `startup.tti`
   * marker's native-side anchor.
   */
  @ReactMethod
  fun getProcessStartTimeMs(promise: Promise) {
    try {
      val startUptimeMs = android.os.Process.getStartUptimeMillis()
      val nowUptimeMs = android.os.SystemClock.uptimeMillis()
      val nowEpochMs = System.currentTimeMillis()
      val epochStart = nowEpochMs - (nowUptimeMs - startUptimeMs)
      promise.resolve(epochStart.toDouble())
    } catch (e: Exception) {
      promise.reject("results_file_process_start_error", e.message, e)
    }
  }
}
