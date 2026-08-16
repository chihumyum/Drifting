#import <TargetConditionals.h>

#if TARGET_OS_IOS || TARGET_OS_MACCATALYST

#import <UIKit/UIKit.h>

@class OIDAuthorizationRequest;
@class OIDAuthorizationResponse;

typedef void (^DriftingOIDAuthorizationCallback)(
    OIDAuthorizationResponse *_Nullable response,
    NSError *_Nullable error);

@interface OIDAuthorizationService : NSObject

+ (id)presentAuthorizationRequest:(OIDAuthorizationRequest *)request
                 externalUserAgent:(id)externalUserAgent
                          callback:(DriftingOIDAuthorizationCallback)callback;

@end

@interface OIDExternalUserAgentIOS : NSObject

- (instancetype)initWithPresentingViewController:
    (UIViewController *)presentingViewController;
- (instancetype)initWithPresentingViewController:
                    (UIViewController *)presentingViewController
                         prefersEphemeralSession:(BOOL)prefersEphemeralSession;

@end

@interface OIDExternalUserAgentCatalyst : NSObject

- (instancetype)initWithPresentingViewController:
    (UIViewController *)presentingViewController;
- (instancetype)initWithPresentingViewController:
                    (UIViewController *)presentingViewController
                         prefersEphemeralSession:(BOOL)prefersEphemeralSession;

@end

// AppAuth ships these entry points in an Objective-C category. Tauri combines
// every mobile plugin into one static archive, where a global -ObjC flag also
// force-loads duplicate Swift support objects. Keeping the two adapter methods
// in the app target makes the selectors available without widening linkage for
// the rest of that archive.
@implementation OIDAuthorizationService (DriftingIOSPresentation)

+ (id)presentAuthorizationRequest:(OIDAuthorizationRequest *)request
    presentingViewController:(UIViewController *)presentingViewController
                    callback:(DriftingOIDAuthorizationCallback)callback {
  id externalUserAgent;
#if TARGET_OS_MACCATALYST
  externalUserAgent = [[OIDExternalUserAgentCatalyst alloc]
      initWithPresentingViewController:presentingViewController];
#else
  externalUserAgent = [[OIDExternalUserAgentIOS alloc]
      initWithPresentingViewController:presentingViewController];
#endif
  return [self presentAuthorizationRequest:request
                         externalUserAgent:externalUserAgent
                                  callback:callback];
}

+ (id)presentAuthorizationRequest:(OIDAuthorizationRequest *)request
    presentingViewController:(UIViewController *)presentingViewController
     prefersEphemeralSession:(BOOL)prefersEphemeralSession
                    callback:(DriftingOIDAuthorizationCallback)callback {
  id externalUserAgent;
#if TARGET_OS_MACCATALYST
  externalUserAgent = [[OIDExternalUserAgentCatalyst alloc]
      initWithPresentingViewController:presentingViewController
               prefersEphemeralSession:prefersEphemeralSession];
#else
  externalUserAgent = [[OIDExternalUserAgentIOS alloc]
      initWithPresentingViewController:presentingViewController
               prefersEphemeralSession:prefersEphemeralSession];
#endif
  return [self presentAuthorizationRequest:request
                         externalUserAgent:externalUserAgent
                                  callback:callback];
}

@end

#endif
