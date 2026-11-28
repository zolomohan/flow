// swift-tools-version:5.3

import PackageDescription

let package = Package(
  name: "tauri-plugin-native-tabs",
  platforms: [
    .iOS(.v13)
  ],
  products: [
    .library(
      name: "tauri-plugin-native-tabs",
      type: .static,
      targets: ["tauri-plugin-native-tabs"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-native-tabs",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
