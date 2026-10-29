/** The Anime4K chain, as the one table the settings row and the player both read.
 *
 *  The shaders are bundled with the app (resources/shaders/anime4k, Anime4K v4.0.1, MIT — the licence rides
 *  along in that folder) rather than fetched: they are the feature, and a URL that goes away after a release
 *  would leave a switch on the settings page that does nothing when pressed.
 *
 *  The four answers are Anime4K's own modes cut down to the ones a film and an episode both make sense in.
 *  轻度 is the restore pass alone with the clamp in front of it: those shaders carry no WHEN gate, so they
 *  run at every window size, and restoration is what a compressed release actually needs. 标准 and 高 add
 *  the 2× passes, and every Upscale_* shader in v4 gates itself on the window being more than 1.2× the
 *  frame — measured 2026-10-29, a 1080p file on a 1080p window changes by a mean of 0.45/255 (nothing
 *  anyone can see), while a 720p file on that window changes by 0.68 with peaks of 30.
 *
 *  Cost is why the row is a choice and not a default, and why 关闭 is what a config with no such key reads
 *  as. Measured inside the app on 2026-10-29 (gpu-next, hwdec auto, RTX 4080, no frame dropped), as CPU% of
 *  one core / GPU%: a 720p file in a 1080p window costs 3.3 / 2.4 with the chain off, 7.3 / 15.0 on 标准 and
 *  9.4 / 14.0 on 高; a 1080p file in a 720p window 3.7 / 3.3, 5.1 / 12.2, 5.4 / 14.6. The money is almost all
 *  in the GPU — the CPU never passed 12%. A 4K source is the expensive corner: the restore pass runs at
 *  2160p even when the window is small, so 高 reaches 48% of the GPU (11.8% of a core).
 *
 *  HDR and this chain do not mix well, which is why 关闭 is the default rather than a warning on the row:
 *  the shaders are written for 0..1 SDR, and Clamp_Highlights then treats a PQ highlight as overshoot.
 *  Measured 2026-10-29 on a 2160p HDR10 file: 标准 dimmed the frame from 116.9 to 106.0 nit (-9.3%) and
 *  pulled the peak from 267.8 to 223.9 (-16%), where the same level on SDR moved pixels by 2.31/255.
 *
 *  Two things this app cannot soften: a 4K file on a 4K window skips every upscaler (that WHEN again), and
 *  mpv compiles the whole list again on every change — which is why a level is applied as one property
 *  write rather than a shader at a time.
 */
export type Anime4kLevel = 'off' | 'light' | 'standard' | 'high';

export const ANIME4K_LEVELS: Anime4kLevel[] = ['off', 'light', 'standard', 'high'];

/** The words the settings row and the player's 画质 row both print, in the order they are offered. */
export const ANIME4K_LABELS: Record<Anime4kLevel, string> = {
  off: '关闭',
  light: '轻度',
  standard: '标准',
  high: '高',
};

/** One line per level, for the settings row's hint: what it does, in the terms the viewer is choosing
 *  between — the file that benefits, and what it costs. */
export const ANIME4K_NOTES: Record<Anime4kLevel, string> = {
  off: '原样输出，用 mpv 自己的缩放器，最省资源',
  light: '只做线条修复与高光压制，不放大：1080p 的番剧也能看出线条更干净',
  standard: '修复加 2 倍放大，成本适中：720p 片源放到 1080p 窗口效果最明显',
  high: '更重的修复加放大，画面最锐，显卡占用明显升高：适合片源好、机器有余的时候',
};

/** Shader files for each level, relative to resources/shaders/anime4k and in the order mpv must load them:
 *  the clamp first (it clips the overshoot the CNN passes would ring on), then the restore pass, then the
 *  upscalers and the auto-downscale pair that keeps a 2× pass from being applied to a frame already bigger
 *  than the window. Sharing the table is the point — the main process hands these names to mpv, and the
 *  player's 画质 row counts them to say how many passes a level runs. */
export const ANIME4K_SHADERS: Record<Anime4kLevel, string[]> = {
  off: [],
  light: ['Restore/Anime4K_Clamp_Highlights.glsl', 'Restore/Anime4K_Restore_CNN_M.glsl'],
  standard: [
    'Restore/Anime4K_Clamp_Highlights.glsl',
    'Restore/Anime4K_Restore_CNN_VL.glsl',
    'Upscale/Anime4K_Upscale_CNN_x2_VL.glsl',
    'Upscale/Anime4K_AutoDownscalePre_x2.glsl',
    'Upscale/Anime4K_AutoDownscalePre_x4.glsl',
    'Upscale/Anime4K_Upscale_CNN_x2_M.glsl',
  ],
  high: [
    'Restore/Anime4K_Clamp_Highlights.glsl',
    'Restore/Anime4K_Restore_CNN_Soft_UL.glsl',
    'Upscale/Anime4K_Upscale_CNN_x2_UL.glsl',
    'Upscale/Anime4K_AutoDownscalePre_x2.glsl',
    'Upscale/Anime4K_AutoDownscalePre_x4.glsl',
    'Upscale/Anime4K_Upscale_CNN_x2_M.glsl',
  ],
};

/** A config file is hand-editable, so a value the row can no longer print reads as 关闭 rather than as a
 *  level nothing matches — the same rule 首选语言 follows. */
export const isAnime4kLevel = (v: unknown): v is Anime4kLevel =>
  typeof v === 'string' && (ANIME4K_LEVELS as readonly string[]).includes(v);
