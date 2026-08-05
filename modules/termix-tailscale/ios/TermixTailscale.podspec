require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

lib_dir = File.join(__dir__, 'lib')
native_dir = File.join(__dir__, '..', 'native')
has_go_archive = File.exist?(File.join(lib_dir, 'libtermix_ts.a'))

Pod::Spec.new do |s|
  s.name           = 'TermixTailscale'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = 'MIT'
  s.author         = 'Termix'
  s.homepage       = 'https://github.com/Termix-SSH/Mobile'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Do NOT set SWIFT_OBJC_BRIDGING_HEADER — CocoaPods builds this as a
  # framework target, and bridging headers are unsupported there.
  # TermixTSBridge.h is a public header so Swift in the same module sees it.

  s.source_files = 'TermixTailscaleModule.swift', 'TermixTSBridge.{h,m}'
  s.public_header_files = 'TermixTSBridge.h'

  common_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES' => 'YES',
    'OTHER_LDFLAGS' => '-lresolv -framework Security -framework Network -framework CoreFoundation'
  }

  if has_go_archive
    s.vendored_libraries = 'lib/libtermix_ts.a'
    s.preserve_paths = 'lib/*'
    # C API header used only by TermixTSBridge.m (not part of the Swift module).
    s.pod_target_xcconfig = common_xcconfig.merge(
      'HEADER_SEARCH_PATHS' => "\"#{lib_dir}\""
    )
  else
    # Dev / CI without a prebuilt Go archive: compile the failing stub.
    s.source_files = 'TermixTailscaleModule.swift', 'TermixTSBridge.{h,m}', '../native/stub.c'
    s.pod_target_xcconfig = common_xcconfig.merge(
      'HEADER_SEARCH_PATHS' => "\"#{native_dir}\""
    )
  end
end
