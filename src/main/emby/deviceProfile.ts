/**
 * The negotiation profile.
 *
 * Verified against this server: with these codecs listed it answers `SupportsDirectPlay=true` for 4K
 * HEVC Main10 + E-AC3 and never transcodes, while a narrower profile flips `SupportsTranscoding` — so
 * the body is honoured, and the only honest claim a self-built client can make is which decoders mpv
 * really has. It has all of them (mpv ships ffmpeg's full decoder set), which is why the ladder is
 * bounded by the bitrate cap rather than by pretending h265 is unsupported.
 *
 * The cap is the one number that decides the round trip: `MaxBitrate` on the transcoding profile is set
 * to the tier the user picked, so a 4K file at 10 Mbps comes back as a 10 Mbps transcode instead of the
 * fixed 8 Mbps the old table promised regardless of what the row said.
 */

const VIDEO = 'hevc,h264,av1,vp9,vp8,mpeg4,mpeg2video,vc1,avc,mpeg1video,mpeg2ts';
const AUDIO = 'truehd,eac3,ac3,dts,dtshd,dca,flac,aac,mp3,opus,vorbis,alac,wav,pcm_s16le,pcm_s24le,pcm_f32le';

/** 7.1 survives at the top of the ladder and drops to stereo only where the cap forces the server's
 *  hand, so a low rung cannot silently cost the multitrack someone paid for. */
const channelsFor = (tier: number): string => (tier >= 60_000_000 || tier === 0 ? '7.1' : tier >= 12_000_000 ? '5.1' : '2');

export function buildDeviceProfile(tier: number) {
  const cap = tier || 400_000_000;
  const channels = channelsFor(tier);
  return {
    EnableTranscoding: tier > 0,
    EnableDirectStream: true,
    EnableDirectPlay: true,
    MaxStreamingBitrate: cap,
    MaxStaticBitrate: cap,
    MusicStreamingTranscodingBitrate: cap,
    MaxAudioChannels: channels,
    SupportedInsecureMethods: 'http-get',
    SupportDolbyVision: true,
    VideoCodecs: VIDEO,
    AudioCodecs: AUDIO,
    ContainerProfiles: [],
    DirectPlayProfiles: [
      { Container: 'mp4,m4v,m4a', Type: 'Video', VideoCodec: VIDEO, AudioCodec: AUDIO },
      { Container: 'mkv,webm', Type: 'Video', VideoCodec: VIDEO, AudioCodec: AUDIO },
      { Container: 'ts,m2ts,mpegts', Type: 'Video', VideoCodec: VIDEO, AudioCodec: AUDIO },
      { Container: 'avi,wmv,asf,flv,mov,3gp,mxf,mpg,mpeg,vob', Type: 'Video', VideoCodec: VIDEO, AudioCodec: AUDIO },
      { Container: 'mp3,flac,wav,aac,ogg,opus,m4a', Type: 'Audio', AudioCodec: AUDIO },
    ],
    TranscodingProfiles: [
      {
        Container: 'ts',
        Type: 'Video',
        AudioCodec: 'aac,mp3,ac3,eac3',
        VideoCodec: 'h264,hevc',
        Context: 'Streaming',
        Protocol: 'hls',
        MaxAudioChannels: channels,
        MinBitrate: '0',
        MaxBitrate: String(cap),
        BreakOnNonKeyFrames: true,
      },
      {
        Container: 'mp3',
        Type: 'Audio',
        AudioCodec: 'mp3',
        Context: 'Streaming',
        Protocol: 'http',
        MaxAudioChannels: '2',
        MinBitrate: '0',
        MaxBitrate: String(cap),
      },
    ],
    SubtitleProfiles: [
      // ASS keeps its styling when mpv renders the subtitle itself, which is what happens on every direct
      // path here; a burned-in subtitle would lose it, so nothing asks for burning.
      { Format: 'ass,ssa', Method: 'Embed', DidlMode: '', Language: '' },
      { Format: 'ass,ssa', Method: 'External', DidlMode: '', Language: '' },
      { Format: 'pgssub,dvdsub', Method: 'Embed', DidlMode: '', Language: '' },
      { Format: 'srt,vtt,sup', Method: 'External', DidlMode: '', Language: '' },
      { Format: 'srt,vtt', Method: 'Embed', DidlMode: '', Language: '' },
    ],
    // Without this the server answers a playlist request with `video/mp2t` and a body of TypeScript
    // segment names, and the rewrite in the bridge would be guessing.
    ResponseProfiles: [{ Type: 'm3u8', Container: 'ts', AttachName: false }],
  };
}
