#import "TermixTSBridge.h"
#import "termix_ts.h"

static NSString *TermixTSLastErrorString(void) {
  char *msg = TermixTS_LastError();
  if (!msg) {
    return @"unknown error";
  }
  NSString *text = [NSString stringWithUTF8String:msg];
  TermixTS_FreeString(msg);
  if (text.length == 0) {
    return @"unknown error";
  }
  return text;
}

@implementation TermixTSBridge

+ (NSString *)configureWithAuthKey:(NSString *)authKey
                          hostname:(NSString *)hostname
                          stateDir:(NSString *)stateDir
                         ephemeral:(BOOL)ephemeral {
  int rc = TermixTS_Configure(authKey.UTF8String ?: "",
                              hostname.UTF8String ?: "termix-mobile",
                              stateDir.UTF8String ?: "",
                              ephemeral ? 1 : 0);
  if (rc != 0) {
    return TermixTSLastErrorString();
  }
  return nil;
}

+ (NSString *)up {
  int rc = TermixTS_Up();
  if (rc != 0) {
    return TermixTSLastErrorString();
  }
  return nil;
}

+ (NSDictionary *)startForwardToHost:(NSString *)remoteHost
                                port:(int)remotePort {
  int localPort = 0;
  int rc = TermixTS_StartForward(remoteHost.UTF8String ?: "", remotePort, &localPort);
  if (rc != 0) {
    return @{@"error" : TermixTSLastErrorString()};
  }
  return @{@"localPort" : @(localPort)};
}

+ (NSString *)stopForwardToHost:(NSString *)remoteHost
                           port:(int)remotePort
                      localPort:(int)localPort {
  int rc = TermixTS_StopForward(remoteHost.UTF8String ?: "", remotePort, localPort);
  if (rc != 0) {
    return TermixTSLastErrorString();
  }
  return nil;
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
  if (raw) {
    TermixTS_FreeString(raw);
  }
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
