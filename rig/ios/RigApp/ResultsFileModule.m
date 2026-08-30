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

@end
