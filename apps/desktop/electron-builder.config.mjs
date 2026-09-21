import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

export default {
  appId: 'com.yb311.personal-newsroom',
  productName: '所闻',
  copyright: 'Copyright © 2026 yb311',
  electronVersion: '44.4.3',
  directories: {
    output: resolve(root, 'release'),
    buildResources: resolve(root, 'assets')
  },
  files: [
    { from: '.', to: '.', filter: ['dist/**/*', 'catalogs/**/*', 'worker.cjs', 'package.json'] },
    { from: 'node_modules', to: 'node_modules', filter: ['**/*'] }
  ],
  npmRebuild: false,
  // A distributable build must fail instead of silently falling back to an
  // unsigned app. `package:dir` remains available for unsigned local checks.
  forceCodeSigning: process.env.PNR_RELEASE_SIGN === '1',
  afterPack: async ({ appOutDir, packager }) => {
    const info = join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Info.plist');
    // Electron's template advertises camera, microphone, Bluetooth and audio
    // capture access even when an app never requests them. Remove those stale
    // declarations before signing so 所闻's privacy surface matches its code.
    for (const key of ['NSAudioCaptureUsageDescription', 'NSBluetoothAlwaysUsageDescription',
                       'NSBluetoothPeripheralUsageDescription', 'NSCameraUsageDescription',
                       'NSMicrophoneUsageDescription']) {
      try { execFileSync('/usr/bin/plutil', ['-remove', key, info]); }
      catch { /* a future Electron template may already omit it */ }
    }
  },
  asar: true,
  asarUnpack: [
    'node_modules/**/*.node',
    'node_modules/**/*.dylib'
  ],
  artifactName: '${productName}-${version}-${arch}.${ext}',
  mac: {
    target: ['dmg', 'zip'],
    icon: resolve(root, 'assets/icon.icns'),
    category: 'public.app-category.news',
    minimumSystemVersion: '13.0',
    hardenedRuntime: true,
    entitlements: resolve(root, 'packaging/entitlements.mac.plist'),
    entitlementsInherit: resolve(root, 'packaging/entitlements.mac.inherit.plist'),
    binaries: ['Contents/Resources/bin/pnr-reader'],
    extraResources: [
      { from: resolve(root, 'assets/Assets.car'), to: 'Assets.car' },
      { from: resolve(root, 'apps/desktop/packaging/bin/pnr-reader'), to: 'bin/pnr-reader' }
    ],
    extraFiles: [
      { from: resolve(root, 'packaging/launch-agents'), to: 'Library/LaunchAgents', filter: ['*.plist'] }
    ],
    extendInfo: {
      CFBundleName: '所闻',
      CFBundleDisplayName: '所闻',
      CFBundleIconName: 'AppIcon',
      CFBundleIconFile: 'icon',
      NSHumanReadableCopyright: 'Copyright © 2026 yb311'
    }
  },
  dmg: {
    title: '所闻 ${version}',
    backgroundColor: '#f5f2eb',
    iconSize: 112,
    contents: [
      { x: 150, y: 180, type: 'file' },
      { x: 430, y: 180, type: 'link', path: '/Applications' }
    ]
  }
};
