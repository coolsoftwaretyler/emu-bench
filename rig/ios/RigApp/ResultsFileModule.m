// Minimal native module backing the rig's results writer and startup
// marker (SPEC.md §9). Registered as a legacy bridge module (works under
// the New Architecture's bridge interop layer, no Codegen needed) rather
// than pulling in a filesystem dependency -- D6 (SPEC.md §2) pins the
// rig's dependency list closed.

#import "ResultsFileModule.h"
#import <mach/mach_time.h>
#import <sys/sysctl.h>

@implementation ResultsFileModule

RCT_EXPORT_MODULE(ResultsFile);

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

// Absolute path to the app's NSDocumentDirectory, mirroring Android's
// files dir so both platforms write `embench-results.json` to a directory
// the host can pull with `simctl get_app_container ... data`.
RCT_EXPORT_METHOD(getDocumentsPath:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSArray *paths = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
  resolve(paths.firstObject);
}

// Writes `contents` to `<documentsPath>/<filename>`, creating parent
// directories if needed. Overwrites any existing file.
RCT_EXPORT_METHOD(writeFile:(NSString *)filename
                  contents:(NSString *)contents
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSArray *paths = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
  NSString *documentsPath = paths.firstObject;
  NSString *fullPath = [documentsPath stringByAppendingPathComponent:filename];

  NSError *error = nil;
  BOOL ok = [contents writeToFile:fullPath
                        atomically:YES
                          encoding:NSUTF8StringEncoding
                             error:&error];
  if (ok) {
    resolve(fullPath);
  } else {
    reject(@"results_file_write_error", error.localizedDescription, error);
  }
}

// Native process-start timestamp (epoch ms), derived from the process's
// mach absolute start time. Feeds the `startup.tti` marker's native-side
// anchor.
RCT_EXPORT_METHOD(getProcessStartTimeMs:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  struct kinfo_proc info;
  size_t length = sizeof(info);
  int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid() };

  if (sysctl(mib, 4, &info, &length, NULL, 0) == 0) {
    struct timeval startTime = info.kp_proc.p_starttime;
    double epochMs = (double)startTime.tv_sec * 1000.0 + (double)startTime.tv_usec / 1000.0;
    resolve(@(epochMs));
  } else {
    reject(@"results_file_process_start_error", @"sysctl KERN_PROC_PID failed", nil);
  }
}

// Reads `<documentsPath>/<filename>` as UTF-8 text. Ticket T05 (Group 5,
// `io.files`) needs a plain-file read path alongside the existing
// `writeFile`; added here rather than as a new dependency (D6 keeps the
// rig's dependency list closed).
RCT_EXPORT_METHOD(readFile:(NSString *)filename
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSArray *paths = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
  NSString *fullPath = [paths.firstObject stringByAppendingPathComponent:filename];

  NSError *error = nil;
  NSString *contents = [NSString stringWithContentsOfFile:fullPath
                                                  encoding:NSUTF8StringEncoding
                                                     error:&error];
  if (contents != nil) {
    resolve(contents);
  } else {
    reject(@"results_file_read_error", error.localizedDescription, error);
  }
}

// Deletes `<documentsPath>/<filename>` if it exists. Resolves either way.
RCT_EXPORT_METHOD(deleteFile:(NSString *)filename
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSArray *paths = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
  NSString *fullPath = [paths.firstObject stringByAppendingPathComponent:filename];
  [[NSFileManager defaultManager] removeItemAtPath:fullPath error:nil];
  resolve(nil);
}

// Writes `sizeBytes` of pseudo-random content to `<documentsPath>/
// <filename>`, generated and streamed to disk in fixed-size chunks
// (NSFileHandle + a reused buffer) rather than built up as one Foundation
// string -- `io.files`'s 500 MB streamed-write case would otherwise force
// 500 MB through the JS bridge and heap, measuring JS memory pressure
// instead of the storage path this scene targets (PLAN.md §4 Group 5).
// Returns the bytes actually written.
RCT_EXPORT_METHOD(writeRandomFile:(NSString *)filename
                  sizeBytes:(nonnull NSNumber *)sizeBytes
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSArray *paths = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
  NSString *fullPath = [paths.firstObject stringByAppendingPathComponent:filename];

  [[NSFileManager defaultManager] createFileAtPath:fullPath contents:nil attributes:nil];
  NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:fullPath];
  if (handle == nil) {
    reject(@"results_file_write_random_error", @"could not open file for writing", nil);
    return;
  }

  const NSUInteger chunkSize = 1 << 20; // 1 MiB
  uint8_t *buffer = malloc(chunkSize);
  unsigned long long total = [sizeBytes unsignedLongLongValue];
  unsigned long long written = 0;

  while (written < total) {
    NSUInteger thisChunk = (NSUInteger)MIN((unsigned long long)chunkSize, total - written);
    arc4random_buf(buffer, thisChunk);
    NSData *chunk = [NSData dataWithBytesNoCopy:buffer length:thisChunk freeWhenDone:NO];
    @try {
      [handle writeData:chunk];
    } @catch (NSException *exception) {
      free(buffer);
      [handle closeFile];
      reject(@"results_file_write_random_error", exception.reason, nil);
      return;
    }
    written += thisChunk;
  }
  free(buffer);
  [handle synchronizeFile]; // force the write through to storage -- fsync, not just buffered
  [handle closeFile];
  resolve(@(written));
}

// Reads back `<documentsPath>/<filename>` in fixed-size chunks without
// materializing it as a Foundation object, returning the total byte count
// read (the read-path counterpart to `writeRandomFile`, for the same
// reason).
RCT_EXPORT_METHOD(readFileSize:(NSString *)filename
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSArray *paths = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
  NSString *fullPath = [paths.firstObject stringByAppendingPathComponent:filename];

  NSFileHandle *handle = [NSFileHandle fileHandleForReadingAtPath:fullPath];
  if (handle == nil) {
    reject(@"results_file_read_size_error", @"could not open file for reading", nil);
    return;
  }

  unsigned long long total = 0;
  @try {
    while (true) {
      NSData *chunk = [handle readDataOfLength:(1 << 20)];
      if (chunk.length == 0) break;
      total += chunk.length;
    }
  } @catch (NSException *exception) {
    [handle closeFile];
    reject(@"results_file_read_size_error", exception.reason, nil);
    return;
  }
  [handle closeFile];
  resolve(@(total));
}

@end
