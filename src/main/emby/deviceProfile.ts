/**
 * The negotiation profile.
 *
 * Verified against this server: with these codecs listed it answers `SupportsDirectPlay=true` for 4K
 * HEVC Main10 + E-AC3 and never transcodes, while a narrower profile flips `SupportsTranscoding` — so
 * the body is honoured, and the only honest claim a self-built client can make is which decoders mpv
 * really has. It has all of them (mpv ships ffmpeg's full decoder set).
 *
 * There is one shape of this body and it says 原片: no transcoding, and a cap no file on either gateway
 * comes near. A bitrate cap was never a picture knob here — the app has no encoder, so the only thing a
 * lower number buys is a server that re-makes the file on the fly, and a re-made file is not the version
 * anybody chose to watch. Which picture you get is decided by which row 播放资源 offers, which is why the
 * ladder and this number were removed together.
 */

const VIDEO = 'hevc,h264,av1,vp9,vp8,mpeg4,mpeg2video,vc1,avc,mpeg1video,mpeg2ts';
const AUDIO = 'truehd,eac3,ac3,dts,dtshd,dca,flac,aac,mp3,opus,vorbis,alac,wav,pcm_s16le,pcm_s24le,pcm_f32le';

/** A file's own track is what plays, so nothing here may cost the multitrack someone paid for. */
const CAP = 400_000_000;

export function buildDeviceProfile() {
  return {
    EnableTranscoding: false,
    EnableDirectStream: true,
    EnableDirectPlay: true,
    MaxStreamingBitrate: CAP,
    MaxStaticBitrate: CAP,
    MusicStreamingTranscodingBitrate: CAP,
    MaxAudioChannels: '7.1',
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
    // Never offered a chance to run: `EnableTranscoding` is false and a server that answers with a
    // transcode anyway is refused. They stay in the body because the shape of this reply is what was
    // verified against the gateway, not because a segment list is ever assembled from them.
    TranscodingProfiles: [
      {
        Container: 'ts',
        Type: 'Video',
        AudioCodec: 'aac,mp3,ac3,eac3',
        VideoCodec: 'h264,hevc',
        Context: 'Streaming',
        Protocol: 'hls',
        MaxAudioChannels: '7.1',
        MinBitrate: '0',
        MaxBitrate: String(CAP),
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
        MaxBitrate: String(CAP),
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
    // A library kept as an HLS folder is direct-played as a playlist, and without this the server answers
    // such a playlist request with `video/mp2t` and a body of TypeScript segment names, leaving the
    // rewrite in the bridge to guess.
    ResponseProfiles: [{ Type: 'm3u8', Container: 'ts', AttachName: false }],
  };
}
