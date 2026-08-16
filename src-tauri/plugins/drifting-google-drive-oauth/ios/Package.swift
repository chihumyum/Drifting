// swift-tools-version:6.0

import PackageDescription

let package = Package(
  name: "tauri-plugin-drifting-google-drive-oauth",
  platforms: [
    .iOS(.v14),
    .macOS(.v10_15),
  ],
  products: [
    .library(
      name: "tauri-plugin-drifting-google-drive-oauth",
      type: .static,
      targets: ["tauri-plugin-drifting-google-drive-oauth"]),
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api"),
    .package(
      url: "https://github.com/google/GoogleSignIn-iOS",
      exact: "9.2.0"),
  ],
  targets: [
    .target(
      name: "tauri-plugin-drifting-google-drive-oauth",
      dependencies: [
        .byName(name: "Tauri"),
        .product(name: "GoogleSignIn", package: "GoogleSignIn-iOS"),
      ],
      path: "Sources"),
  ],
  swiftLanguageModes: [.v5]
)
