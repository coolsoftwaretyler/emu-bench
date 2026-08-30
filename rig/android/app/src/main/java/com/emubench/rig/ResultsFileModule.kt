package com.emubench.rig

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.RandomAccessFile
import java.security.SecureRandom

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

  /**
   * Reads `<documentsPath>/<filename>` as UTF-8 text. Ticket T05 (Group 5,
   * `io.files`) needs a plain-file read path alongside the existing
   * `writeFile`; added here rather than as a new dependency (D6 keeps the
   * rig's dependency list closed).
   */
  @ReactMethod
  fun readFile(filename: String, promise: Promise) {
    try {
      val file = File(reactApplicationContext.filesDir, filename)
      promise.resolve(file.readText())
    } catch (e: Exception) {
      promise.reject("results_file_read_error", e.message, e)
    }
  }

  /** Deletes `<documentsPath>/<filename>` if it exists. Resolves either way. */
  @ReactMethod
  fun deleteFile(filename: String, promise: Promise) {
    try {
      File(reactApplicationContext.filesDir, filename).delete()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("results_file_delete_error", e.message, e)
    }
  }

  /**
   * Writes `sizeBytes` of pseudo-random content to `<documentsPath>/
   * <filename>`, generated and streamed to disk in fixed-size chunks
   * (`RandomAccessFile` + a reused buffer) rather than built up as one JS
   * string -- `io.files`'s 500 MB streamed-write case would otherwise
   * force a 500 MB string across the bridge and through the JS heap,
   * measuring JS memory pressure instead of the storage path this scene
   * targets (PLAN.md §4 Group 5). Returns the bytes actually written.
   */
  @ReactMethod
  fun writeRandomFile(filename: String, sizeBytes: Double, promise: Promise) {
    try {
      val dir = reactApplicationContext.filesDir
      if (!dir.exists()) dir.mkdirs()
      val file = File(dir, filename)
      val total = sizeBytes.toLong()
      val chunkSize = 1 shl 20 // 1 MiB
      val buffer = ByteArray(chunkSize)
      val random = SecureRandom()
      var written = 0L
      RandomAccessFile(file, "rw").use { raf ->
        raf.setLength(0)
        while (written < total) {
          val thisChunk = minOf(chunkSize.toLong(), total - written).toInt()
          random.nextBytes(buffer)
          raf.write(buffer, 0, thisChunk)
          written += thisChunk
        }
        raf.fd.sync() // force the write through to storage -- fsync, not just buffered
      }
      promise.resolve(written.toDouble())
    } catch (e: Exception) {
      promise.reject("results_file_write_random_error", e.message, e)
    }
  }

  /**
   * Reads back `<documentsPath>/<filename>` in fixed-size chunks without
   * materializing it in the JS heap, returning the total byte count read
   * (the read-path counterpart to `writeRandomFile`, for the same reason).
   */
  @ReactMethod
  fun readFileSize(filename: String, promise: Promise) {
    try {
      val file = File(reactApplicationContext.filesDir, filename)
      val buffer = ByteArray(1 shl 20)
      var total = 0L
      file.inputStream().use { input ->
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          total += read
        }
      }
      promise.resolve(total.toDouble())
    } catch (e: Exception) {
      promise.reject("results_file_read_size_error", e.message, e)
    }
  }
}
