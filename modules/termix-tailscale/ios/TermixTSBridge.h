#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * ObjC façade over the C/Go TermixTS_* API.
 *
 * Intentionally avoids NSError** out-params so Swift import is boring and stable:
 * failure is an NSString message (nil = success), or a dictionary with "error".
 */
@interface TermixTSBridge : NSObject

/// Whether the real Go archive is linked (false when stub.c is in use).
+ (BOOL)isAvailable;

/// Publish route policy, validated physical interface, and material generation.
+ (void)updateRoutePolicy:(int)policy
        physicalInterface:(NSString *)interfaceName
               generation:(uint64_t)generation;

/// Immediately cancel/invalidate native Up and probe operations. Never waits.
+ (void)cancelCurrentOperation;

/// nil on success, error message on failure.
+ (NSString * _Nullable)configureWithAuthKey:(NSString *)authKey
                                    hostname:(NSString *)hostname
                                    stateDir:(NSString *)stateDir
                                   ephemeral:(BOOL)ephemeral;

/// nil on success, error message on failure.
+ (NSString * _Nullable)up;

/// On success: @{ @"localPort": @(n) }. On failure: @{ @"error": @"..." }.
+ (NSDictionary *)startForwardWithProtocol:(NSString *)protocol
                                      host:(NSString *)remoteHost
                                      port:(int)remotePort;

/// nil on success, error message on failure.
+ (NSString * _Nullable)stopForwardWithProtocol:(NSString *)protocol
                                           host:(NSString *)remoteHost
                                           port:(int)remotePort
                                      localPort:(int)localPort;

/// nil on success, error message on failure.
+ (NSString * _Nullable)stopAllForwards;

+ (BOOL)isForwardActiveWithProtocol:(NSString *)protocol
                               host:(NSString *)remoteHost
                               port:(int)remotePort
                          localPort:(int)localPort;

/// YES when the forward is registered and its target answers over the tailnet.
+ (BOOL)probeForwardWithProtocol:(NSString *)protocol
                            host:(NSString *)remoteHost
                            port:(int)remotePort
                       localPort:(int)localPort;

+ (BOOL)isUp;

+ (NSString *)ips;

/// nil on success, error message on failure.
+ (NSString * _Nullable)close;

+ (NSString *)defaultStateDir;

@end

NS_ASSUME_NONNULL_END
