// narrate record — screen + mic + cursor-event capture.
// Output folder: screen.mp4 (cursor hidden), mic.caf, events.json
// All timestamps are host-clock seconds (CACurrentMediaTime), so video, mic
// and events line up without guessing.

import AppKit
import AVFoundation
import ScreenCaptureKit
import QuartzCore

// MARK: - Args
struct Options {
    var out: URL
    var fps: Int = 60
    var mic = true
    var displayIndex = 0
}

func parseArgs() -> Options {
    var args = Array(CommandLine.arguments.dropFirst())
    if args.first == "record" { args.removeFirst() }
    let stamp: String = {
        let f = DateFormatter(); f.dateFormat = "yyyyMMdd-HHmmss"; return f.string(from: Date())
    }()
    var o = Options(out: URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent("Projects/narrate/recordings/\(stamp)"))
    var i = 0
    while i < args.count {
        switch args[i] {
        case "--out": i += 1; o.out = URL(fileURLWithPath: (args[i] as NSString).expandingTildeInPath)
        case "--fps": i += 1; o.fps = Int(args[i]) ?? 60
        case "--no-mic": o.mic = false
        case "--display": i += 1; o.displayIndex = Int(args[i]) ?? 0
        case "-h", "--help":
            print("usage: narrate record [--out DIR] [--fps N] [--no-mic] [--display N]\nPress Enter or Ctrl-C to stop.")
            exit(0)
        default: break
        }
        i += 1
    }
    return o
}

// MARK: - Event log
struct ClickEvent: Codable { let t: Double; let type: String; let button: String; let x: Double; let y: Double }
struct ScrollEvent: Codable { let t: Double; let dx: Double; let dy: Double; let x: Double; let y: Double }
struct DisplayInfo: Codable { let id: UInt32; let width: Int; let height: Int; let scale: Double; let pointWidth: Double; let pointHeight: Double }
struct EventLog: Codable {
    var version = 1
    var display: DisplayInfo
    var fps: Int
    var t0Video: Double? = nil      // host seconds of first video frame
    var t0Mic: Double? = nil        // host seconds of first mic buffer
    var tEnd: Double? = nil
    var moves: [[Double]] = []      // [t, x, y] in display pixels, origin top-left
    var clicks: [ClickEvent] = []
    var scrolls: [ScrollEvent] = []
}

// MARK: - Recorder
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let opts: Options
    var log: EventLog
    let display: SCDisplay
    let screenFrame: CGRect       // points, AppKit coords (origin bottom-left)
    let scale: CGFloat

    var stream: SCStream!
    var writer: AVAssetWriter!
    var videoInput: AVAssetWriterInput!
    var adaptor: AVAssetWriterInputPixelBufferAdaptor!
    var firstPTS: CMTime?
    var frames = 0

    var engine: AVAudioEngine?
    var micFile: AVAudioFile?

    var monitors: [Any] = []
    var sampler: Timer?
    var stopping = false

    init(opts: Options, display: SCDisplay, screen: NSScreen) {
        self.opts = opts
        self.display = display
        self.screenFrame = screen.frame
        self.scale = screen.backingScaleFactor
        let w = Int(screen.frame.width * scale), h = Int(screen.frame.height * scale)
        self.log = EventLog(display: DisplayInfo(id: display.displayID, width: w, height: h, scale: scale,
                                                 pointWidth: screen.frame.width, pointHeight: screen.frame.height),
                            fps: opts.fps)
    }

    func start() async throws {
        try FileManager.default.createDirectory(at: opts.out, withIntermediateDirectories: true)

        // --- video writer
        let w = log.display.width, h = log.display.height
        writer = try AVAssetWriter(outputURL: opts.out.appendingPathComponent("screen.mp4"), fileType: .mp4)
        let bitrate = max(20_000_000, w * h * 6) // ~6 bits/pixel/s → ~70 Mbps at retina 4K-ish
        videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: w, AVVideoHeightKey: h,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoExpectedSourceFrameRateKey: opts.fps,
                AVVideoMaxKeyFrameIntervalKey: opts.fps,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ])
        videoInput.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: videoInput, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h,
        ])
        writer.add(videoInput)
        guard writer.startWriting() else { throw writer.error ?? NSError(domain: "narrate", code: 1) }

        // --- screen stream (cursor hidden: we render it ourselves later)
        let filter = SCContentFilter(display: display, excludingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.width = w; cfg.height = h
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(opts.fps))
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.showsCursor = false
        cfg.queueDepth = 6
        cfg.capturesAudio = false
        stream = SCStream(filter: filter, configuration: cfg, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "narrate.video"))

        // --- mic
        if opts.mic {
            let eng = AVAudioEngine()
            let input = eng.inputNode
            let fmt = input.outputFormat(forBus: 0)
            let url = opts.out.appendingPathComponent("mic.caf")
            let file = try AVAudioFile(forWriting: url, settings: fmt.settings, commonFormat: fmt.commonFormat, interleaved: fmt.isInterleaved)
            input.installTap(onBus: 0, bufferSize: 2048, format: fmt) { [weak self] buf, when in
                guard let self, !self.stopping else { return }
                if self.log.t0Mic == nil {
                    self.log.t0Mic = AVAudioTime.seconds(forHostTime: when.hostTime)
                }
                try? file.write(from: buf)
            }
            try eng.start()
            engine = eng; micFile = file
        }

        // --- input events
        let moveMask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
        monitors.append(NSEvent.addGlobalMonitorForEvents(matching: moveMask) { [weak self] e in
            self?.logMove(e.locationInWindow)
        }!)
        let clickMask: NSEvent.EventTypeMask = [.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp]
        monitors.append(NSEvent.addGlobalMonitorForEvents(matching: clickMask) { [weak self] e in
            guard let self else { return }
            let p = self.toPixels(NSEvent.mouseLocation)
            let type: String = [.leftMouseDown, .rightMouseDown, .otherMouseDown].contains(e.type) ? "down" : "up"
            let button: String = e.type == .leftMouseDown || e.type == .leftMouseUp ? "left"
                : e.type == .rightMouseDown || e.type == .rightMouseUp ? "right" : "other"
            self.log.clicks.append(ClickEvent(t: CACurrentMediaTime(), type: type, button: button, x: p.x, y: p.y))
        }!)
        monitors.append(NSEvent.addGlobalMonitorForEvents(matching: .scrollWheel) { [weak self] e in
            guard let self else { return }
            let p = self.toPixels(NSEvent.mouseLocation)
            self.log.scrolls.append(ScrollEvent(t: CACurrentMediaTime(), dx: e.scrollingDeltaX, dy: e.scrollingDeltaY, x: p.x, y: p.y))
        }!)
        // steady 60 Hz position sampler so the cursor path is dense even when the OS coalesces move events
        sampler = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.logMove(nil)
        }

        try await stream.startCapture()
        fputs("● recording \(w)x\(h) @\(opts.fps)fps → \(opts.out.path)\n  press Enter or Ctrl-C to stop\n", stderr)
    }

    private func toPixels(_ p: NSPoint) -> (x: Double, y: Double) {
        // NSEvent.mouseLocation is bottom-left origin, global points. Convert to this display's top-left pixel coords.
        let x = (p.x - screenFrame.minX) * scale
        let y = (screenFrame.maxY - p.y) * scale
        return (x, y)
    }

    private var lastMove: (Double, Double)?
    private func logMove(_ ignored: NSPoint?) {
        let p = toPixels(NSEvent.mouseLocation)
        if let l = lastMove, l.0 == p.x, l.1 == p.y { return }
        lastMove = (p.x, p.y)
        log.moves.append([CACurrentMediaTime(), p.x, p.y])
    }

    // SCStreamOutput
    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, !stopping, sb.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let statusRaw = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: statusRaw) == .complete,
              let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        if firstPTS == nil {
            firstPTS = pts
            log.t0Video = pts.seconds   // SCStream PTS is on the host clock
            writer.startSession(atSourceTime: .zero)
        }
        guard videoInput.isReadyForMoreMediaData else { return }
        adaptor.append(pb, withPresentationTime: pts - firstPTS!)
        frames += 1
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fputs("stream stopped: \(error.localizedDescription)\n", stderr)
        Task { await self.stop() }
    }

    func stop() async {
        if stopping { return }
        stopping = true
        log.tEnd = CACurrentMediaTime()
        sampler?.invalidate()
        monitors.forEach { NSEvent.removeMonitor($0) }
        try? await stream.stopCapture()
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        micFile = nil
        videoInput.markAsFinished()
        await writer.finishWriting()
        let enc = JSONEncoder(); enc.outputFormatting = [.sortedKeys]
        if let data = try? enc.encode(log) {
            try? data.write(to: opts.out.appendingPathComponent("events.json"))
        }
        let dur = (log.tEnd ?? 0) - (log.t0Video ?? 0)
        fputs(String(format: "■ stopped. %d frames, %.1fs, %d moves, %d clicks\n  %@\n", frames, dur, log.moves.count, log.clicks.count, opts.out.path), stderr)
        if writer.status == .failed { fputs("writer error: \(writer.error?.localizedDescription ?? "?")\n", stderr) }
        NSApp.terminate(nil)
    }
}

// MARK: - Main
let opts = parseArgs()
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
var recorder: Recorder?

Task { @MainActor in
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let displays = content.displays
        guard opts.displayIndex < displays.count else {
            fputs("no display at index \(opts.displayIndex); have \(displays.count)\n", stderr); exit(2)
        }
        let display = displays[opts.displayIndex]
        let screen = NSScreen.screens.first {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display.displayID
        } ?? NSScreen.main!
        let r = Recorder(opts: opts, display: display, screen: screen)
        recorder = r
        try await r.start()
    } catch {
        fputs("failed to start: \(error.localizedDescription)\n  (System Settings → Privacy & Security → Screen Recording / Microphone)\n", stderr)
        exit(1)
    }
}

// stop on Enter
DispatchQueue.global().async {
    _ = readLine()
    Task { await recorder?.stop() }
}
// stop on Ctrl-C
signal(SIGINT, SIG_IGN)
let sigSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigSrc.setEventHandler { Task { await recorder?.stop() } }
sigSrc.resume()

app.run()
