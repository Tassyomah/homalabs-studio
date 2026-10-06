// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "narrate",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "narrate",
            path: "Sources/narrate",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("AppKit"),
            ]
        )
    ]
)
