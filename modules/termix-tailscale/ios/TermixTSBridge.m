#import "TermixTSBridge.h"
#import "termix_ts.h"

static NSError *TermixTSError(void) {
  char *msg = TermixTS_LastError();
  NSString *text = msg ? [NSString stringWithUTF8String:msg] : @"unknown error";
  if (msg) TermixTS_FreeString(msg);
  return [NSError errorWithDomain:@"TermixTailscale"
                             code:1
                         userInfo:@{NSLocalizedDescriptionKey : text ?: @"error"}];
}

@implementation TermixTSBridge

+ (BOOL)configureWithAuthKey:(NSString *)authKey
                    hostname:(NSString *)hostname
                    stateDir:(NSString *)stateDir
                   ephemeral:(BOOL)ephemeral
                       error:(NSError **)error {
  int rc = TermixTS_Configure(authKey.UTF8String ?: "",
                              hostname.UTF8String ?: "termix-mobile",
                              stateDir.UTF8String ?: "",
                              ephemeral ? 1 : 0);
  if (rc != 0) {
    if (error) *error = TermixTSError();
    return NO;
  }
  return YES;
}

+ (BOOL)upWithError:(NSError **)error {
  int rc = TermixTS_Up();
  if (rc != 0) {
    if (error) *error = TermixTSError();
    return NO;
  }
  return YES;
}

+ (NSNumber *)startForwardToHost:(NSString *)remoteHost
                            port:(int)remotePort
                           error:(NSError **)error {
  int localPort = 0;
  int rc = TermixTS_StartForward(remoteHost.UTF8String ?: "", remotePort, &localPort);
  if (rc != 0) {
    if (error) *error = TermixTSError();
    return nil;
  }
  return @(localPort);
}

+ (BOOL)stopForwardToHost:(NSString *)remoteHost
                     port:(int)remotePort
                localPort:(int)localPort
                    error:(NSError **)error {
  int rc = TermixTS_StopForward(remoteHost.UTF8String ?: "", remotePort, localPort);
  if (rc != 0) {
    if (error) *error = TermixTSError();
    return NO;
  }
  return YES;
}

+ (void)stopAllForwards {
  TermixTS_StopAllForwards();
}

+ (BOOL)isUp {
  return TermixTS_IsUp() == 1;
}

+ (NSString *)ips {
  char *raw = TermixTS_GetIPs();
  NSString *s = raw ? [NSString stringWithUTF8String:raw] : @"";
  if (raw) TermixTS_FreeString(raw);
  return s ?: @"";
}

+ (void)close {
  TermixTS_Close();
}

+ (NSString *)defaultStateDir {
  NSArray<NSString *> *paths = NSSearchPathForDirectoriesInDomains(
      NSApplicationSupportDirectory, NSUserDomainMask, YES);
  NSString *base = paths.firstObject ?: NSTemporaryDirectory();
  NSString *dir = [base stringByAppendingPathComponent:@"TermixTailscale"];
  [[NSFileManager defaultManager] createDirectoryAtPath:dir
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:nil];
  return dir;
}

@end
