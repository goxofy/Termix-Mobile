require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

lib_dir = File.join(__dir__, 'lib')
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

  s.source_files = 'TermixTailscaleModule.swift', 'TermixTSBridge.{h,m}'
  s.public_header_files = 'TermixTSBridge.h'

  if has_go_archive
    s.vendored_libraries = 'lib/libtermix_ts.a'
    s.header_mappings_dir = 'lib'
    s.preserve_paths = 'lib/*'
    s.pod_target_xcconfig = {
      'HEADER_SEARCH_PATHS' => "\"#{lib_dir}\"",
      'OTHER_LDFLAGS' => '-lresolv -framework Security -framework Network -framework CoreFoundation',
      'DEFINES_MODULE' => 'YES',
      'SWIFT_OBJC_BRIDGING_HEADER' => '$(PODS_TARGET_SRCROOT)/TermixTailscale-Bridging-Header.h',
      'CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES' => 'YES'
    }
  else
    # Dev machines without a built Go archive still link via stub.
    s.source_files = 'TermixTailscaleModule.swift', 'TermixTSBridge.{h,m}', '../native/stub.c', '../native/termix_ts.h'
    s.pod_target_xcconfig = {
      'HEADER_SEARCH_PATHS' => "\"#{File.join(__dir__, '..', 'native')}\"",
      'DEFINES_MODULE' => 'YES',
      'SWIFT_OBJC_BRIDGING_HEADER' => '$(PODS_TARGET_SRCROOT)/TermixTailscale-Bridging-Header.h',
      'CLANG_ALLOW_NON_MODULAR_INCLUDES_IN_FRAMEWORK_MODULES' => 'YES'
    }
  end
end
