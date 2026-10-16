Pod::Spec.new do |s|
  s.name           = 'RetTls'
  s.version        = '1.0.0'
  s.summary        = 'TLS 1.3 with a device key, pinned peers and keying-material export, for Ret remote access'
  s.description    = 'Ret remote access transport: Network.framework TLS with the device identity in the keychain.'
  s.author         = ''
  s.homepage       = 'https://getret.app'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
