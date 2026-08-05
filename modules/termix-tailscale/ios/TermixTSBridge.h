#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface TermixTSBridge : NSObject

+ (BOOL)configureWithAuthKey:(NSString *)authKey
                    hostname:(NSString *)hostname
                    stateDir:(NSString *)stateDir
                   ephemeral:(BOOL)ephemeral
                       error:(NSError *_Nullable *_Nullable)error;

+ (BOOL)upWithError:(NSError *_Nullable *_Nullable)error;

/// Returns local port on success.
+ (NSNumber *_Nullable)startForwardToHost:(NSString *)remoteHost
                                     port:(int)remotePort
                                    error:(NSError *_Nullable *_Nullable)error;

+ (BOOL)stopForwardToHost:(NSString *)remoteHost
                     port:(int)remotePort
                localPort:(int)localPort
                    error:(NSError *_Nullable *_Nullable)error;

+ (void)stopAllForwards;

+ (BOOL)isUp;

+ (NSString *)ips;

+ (void)close;

+ (NSString *)defaultStateDir;

@end

NS_ASSUME_NONNULL_END
