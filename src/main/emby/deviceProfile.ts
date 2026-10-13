import type { Settings } from '../../shared/types';

const VIDEO = 'hevc,h264,av1,vp9,vp8,mpeg4,mpeg2video,vc1,avc';
const AUDIO = 'truehd,eac3,ac3,dts,dtshd,flac,aac,mp3,opus,vorbis,alac,pcm_s16le,pcm_s24le,wav';

/**
 * Negotiation profile. Verified against this server: with these codecs listed it
 * answers SupportsDirectPlay=true for 4K HEVC Main10 + E-AC3 and never transcodes,
 * while a narrower profile flips SupportsTranscoding — i.e. the body is honoured.
 */
export function buildDeviceProfile(settings: Settings) {
  return {
    EnableTranscoding: true,
    EnableDirectStream: true,
    EnableDirectPlay: true,
    MaxStreamingBitrate: settings.maxStreamingBitrate,
    MaxAudioChannels: 7.1,
    SupportedInsecureMethods: 'http-get',
    SupportDolbyVision: true,
    VideoCodecs: VIDEO,
    AudioCodecs: AUDIO,
    ContainerProfiles: [],
    DirectPlayProfiles: [
      { Container: 'mp4,m4v', Type: 'Video', VideoCodec: VIDEO, AudioCodec: AUDIO },
      { Container: 'mkv', Type: 'Video', VideoCodec: VIDEO, AudioCodec: AUDIO },
      { Container: 'webm', Type: 'Video', VideoCodec: 'vp9,vp8,av1', AudioCodec: 'opus,vorbis,flac' },
      { Container: 'ts,m2ts,mpegts', Type: 'Video', VideoCodec: 'hevc,h264,vc1,mpeg2video', AudioCodec: AUDIO },
      { Container: 'mp3,flac,wav,m4a,aac', Type: 'Audio', AudioCodec: AUDIO },
    ],
    TranscodingProfiles: [
      {
        Container: 'ts', Type: 'Video', AudioCodec: 'aac', VideoCodec: 'h264',
        Context: 'Streaming', Protocol: 'hls', MaxAudioChannels: '2', MinBitrate: '0', MaxBitrate: '8000000',
      },
    ],
    SubtitleProfiles: [
      { Format: 'ass,ssa', Method: 'Embed', DidlMode: '', Language: '' },
      { Format: 'ass,ssa', Method: 'External', DidlMode: '', Language: '' },
      { Format: 'pgssub,dvdsub', Method: 'Embed', DidlMode: '', Language: '' },
      { Format: 'srt,vtt', Method: 'External', DidlMode: '', Language: '' },
      { Format: 'srt,vtt', Method: 'Embed', DidlMode: '', Language: '' },
    ],
    ResponseProfiles: [{ Type: 'm3u8' }],
  };
}
