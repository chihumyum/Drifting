// Plays a list of notes on a sampled instrument and writes what it hears,
// offline, with the system's own sampler (AVAudioUnitSampler) — no
// GarageBand window, no real time:
//   swift sampler.swift <instrument.exs|.sf2|.dls> <notes.json> <out.wav> <seconds> [program]
// notes.json is [{ "t": seconds, "note": midi, "velocity": 1–127, "off": seconds }].
// render.mjs uses it for the score's piano and strings when GarageBand's sound
// library is installed. Writes 48 kHz stereo float WAV; note events land on
// 64-sample blocks (1.3 ms).
import AVFoundation
import AudioToolbox

struct Note: Decodable {
  let t: Double
  let note: UInt8
  let velocity: UInt8
  let off: Double
}

let args = CommandLine.arguments
guard args.count >= 5, let seconds = Double(args[4]) else {
  FileHandle.standardError.write("usage: swift sampler.swift <instrument> <notes.json> <out.wav> <seconds> [program]\n".data(using: .utf8)!)
  exit(2)
}
let instrument = URL(fileURLWithPath: args[1])
let notes = try JSONDecoder().decode([Note].self, from: Data(contentsOf: URL(fileURLWithPath: args[2])))
let output = URL(fileURLWithPath: args[3])
let program = args.count > 5 ? UInt8(args[5]) ?? 0 : 0
let rate = 48000.0
let block: AVAudioFrameCount = 64

let engine = AVAudioEngine()
let sampler = AVAudioUnitSampler()
engine.attach(sampler)
engine.connect(sampler, to: engine.mainMixerNode, format: nil)
let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 2)!
try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: block)
try engine.start()
switch instrument.pathExtension.lowercased() {
case "dls", "sf2":
  try sampler.loadSoundBankInstrument(at: instrument, program: program,
    bankMSB: UInt8(kAUSampler_DefaultMelodicBankMSB), bankLSB: UInt8(kAUSampler_DefaultBankLSB))
default:
  try sampler.loadInstrument(at: instrument)
}

// Every note's start and end as one timeline; an end and a start on the same block end first.
var events: [(frame: Int, on: Bool, note: UInt8, velocity: UInt8)] = []
for n in notes {
  events.append((Int(n.t * rate), true, n.note, n.velocity))
  events.append((Int(max(n.off, n.t + 0.01) * rate), false, n.note, 0))
}
events.sort { $0.frame != $1.frame ? $0.frame < $1.frame : (!$0.on && $1.on) }

let file = try AVAudioFile(forWriting: output, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
let buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: block)!
let total = Int(seconds * rate)
var done = 0, next = 0
while done < total {
  let frames = AVAudioFrameCount(min(Int(block), total - done))
  while next < events.count && events[next].frame < done + Int(frames) {
    let e = events[next]
    if e.on { sampler.startNote(e.note, withVelocity: e.velocity, onChannel: 0) } else { sampler.stopNote(e.note, onChannel: 0) }
    next += 1
  }
  let status = try engine.renderOffline(frames, to: buffer)
  guard status == .success else { FileHandle.standardError.write("sampler: render stopped (\(status.rawValue))\n".data(using: .utf8)!); exit(1) }
  try file.write(from: buffer)
  done += Int(frames)
}
