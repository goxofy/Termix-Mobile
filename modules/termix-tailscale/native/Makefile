# Build the Termix Tailscale C archive from official tailscale.com/tsnet.
#
#   make host     # current machine (dev / tests)
#   make ios      # iOS device arm64 archive → ../ios/lib/libtermix_ts.a
#   make android  # needs ANDROID_NDK_HOME
#
# Without a successful Go build, the iOS pod uses stub.c so the app still links.

ROOT := $(abspath .)
IOS_OUT := $(abspath ../ios/lib)
ANDROID_OUT := $(abspath ../android/src/main/jniLibs)
HEADER := termix_ts.h

.PHONY: host ios android clean deps tidy

deps:
	go mod tidy

host: deps
	CGO_ENABLED=1 go build -buildmode=c-archive -o $(ROOT)/libtermix_ts_host.a .
	cp $(HEADER) $(ROOT)/libtermix_ts_host.h 2>/dev/null || true

# Device archive (App Store / device runs). Requires Xcode + iOS SDK.
ios: deps
	mkdir -p $(IOS_OUT)
	GOOS=ios GOARCH=arm64 CGO_ENABLED=1 \
		CC=$(ROOT)/clangwrap-ios.sh \
		go build -tags ios -buildmode=c-archive -o $(IOS_OUT)/libtermix_ts.a .
	cp $(HEADER) $(IOS_OUT)/termix_ts.h
	@echo "Installed $(IOS_OUT)/libtermix_ts.a"

# arm64-v8a shared library for Android.
android: deps
	@test -n "$(ANDROID_NDK_HOME)" || (echo "Set ANDROID_NDK_HOME" && exit 1)
	mkdir -p $(ANDROID_OUT)/arm64-v8a
	GOOS=android GOARCH=arm64 CGO_ENABLED=1 \
		CC="$(ANDROID_NDK_HOME)/toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android24-clang" \
		go build -buildmode=c-shared -o $(ANDROID_OUT)/arm64-v8a/libtermix_ts.so .
	cp $(HEADER) $(ANDROID_OUT)/termix_ts.h
	@echo "Installed $(ANDROID_OUT)/arm64-v8a/libtermix_ts.so"

clean:
	rm -f libtermix_ts_host.a libtermix_ts_host.h
	rm -f $(IOS_OUT)/libtermix_ts.a $(IOS_OUT)/libtermix_ts.h $(IOS_OUT)/termix_ts.h
	rm -rf $(ANDROID_OUT)
