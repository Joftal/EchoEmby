export const fmtClock = (ms: number): string => {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

export const ticksToMs = (ticks?: number): number => Math.round((ticks || 0) / 1e4);

/** How far a viewer got, in milliseconds, from whichever of the two fields this server chose to answer
 *  with. Measured on the resume query: 2 of its 8 rows carry a percentage, 6 carry a position, and the
 *  position is the one an Episode ever gets — a rule that read only the percentage would call most of them
 *  fresh. The position comes first because it is the exact offset the player POSTed, while a percentage is
 *  an integer the gateway rounded before sending it. */
export const stoppedAtMs = (u?: { playedPercentage?: number; positionMs?: number }, runTimeTicks?: number): number => {
  if (!u) return 0;
  const pct = Math.min(100, u.playedPercentage || 0);
  const ms = u.positionMs || (pct > 0 ? Math.round((ticksToMs(runTimeTicks) * pct) / 100) : 0);
  // Under a second there is no stop to print: 播完 rolls straight into the next episode and that switch
  // flushes the one that just began, which measured pos=33 - a card reading 「看到 0:00」 under 继续播放.
  return ms >= 1000 ? ms : 0;
};

/** How far through a row the viewer got, as 0..1, off whichever of the two fields this server answered
 *  with. The percentage is the sparse one — measured over 200 raw 在看 rows it appears on 3, while 15 of
 *  this page's 94 folded rows carry an offset — so the offset over the row's own runtime is the number a
 *  bar should read, and the percentage only stands in for the rows this fork answers that way instead. */
export const watchedRatio = (u?: { playedPercentage?: number; positionMs?: number }, runTimeTicks?: number): number => {
  const ms = stoppedAtMs(u, runTimeTicks);
  const full = ticksToMs(runTimeTicks);
  if (ms > 0 && full > 0) return Math.min(1, ms / full);
  return Math.min(1, (u?.playedPercentage || 0) / 100);
};

/** The progress read-out, 「看到 27:06」 — the one wording every surface that answers how far a viewer got
 *  prints, off the one number above. The hero's button used to count whole minutes off the position while
 *  the card's chip multiplied a rounded percentage by the runtime, so the same episode said 「已播 29 分钟」
 *  under 继续播放 and 「看到 27:06」 on its own card. */
export const seenLabel = (u?: { playedPercentage?: number; positionMs?: number }, runTimeTicks?: number): string => {
  const ms = stoppedAtMs(u, runTimeTicks);
  return ms > 0 ? `看到 ${fmtClock(ms)}` : '';
};

/** Where the show is - 「第 1 季 · 第 2 集」 - the one wording every episode surface reads. A row that
 *  does not say which season it sits in drops that half rather than guessing. Counts (「8 集」、「3 季」)
 *  are not positions and stay bare. */
export const episodePosition = (season?: number | null, episode?: number | null): string => {
  if (episode == null) return '';
  return season != null ? `第 ${season} 季 · 第 ${episode} 集` : `第 ${episode} 集`;
};

/** Emby names a track's language with an ISO-639-2 code (`jpn`, `chi`, `und`), which is not a thing a viewer
 *  reads. This is the one table that spells those codes out: the player's track menu, the 技术信息 card and
 *  the 资源库 language filter all read through `langName`, so a viewer who ticks 「日语」 to find a title does
 *  not then read 「日文」 inside it. The keys below are what these gateways answer with, measured over
 *  1,600 files (the newest 400 plus the first 400 by name on each) and then topped up from a 468-file
 *  sample on 2026-10-26; a code the table does not know prints as itself rather than as a guess.
 *  Both spellings ride along where a gateway uses ISO-639-2/B (`ice` for Icelandic, `slo` for Slovak,
 *  `baq` for Basque, `mac` for Macedonian), because 蜘蛛侠：崭新之日 carries `slo` and `slv` as two
 *  different subtitle tracks in one file, so reading `slo` as Slovenian would name one language twice. */
const LANGS: Record<string, string> = {
  zho: '中文', chi: '中文', chs: '中文（简）', zht: '中文（繁）', cht: '中文（繁）', zh: '中文', yue: '粤语',
  eng: '英语', en: '英语', jpn: '日语', kor: '韩语', fre: '法语', fra: '法语', ger: '德语', deu: '德语',
  spa: '西班牙语', ita: '意大利语', rus: '俄语', por: '葡萄牙语', tha: '泰语', vie: '越南语', und: '无语言',
  ind: '印尼语', may: '马来语', fil: '菲律宾语', ara: '阿拉伯语', bul: '保加利亚语', cze: '捷克语',
  hun: '匈牙利语', swe: '瑞典语', dut: '荷兰语', fin: '芬兰语', rum: '罗马尼亚语', gre: '希腊语',
  hin: '印地语', tur: '土耳其语', nob: '挪威语', nor: '挪威语', dan: '丹麦语', pol: '波兰语',
  slo: '斯洛伐克语', slv: '斯洛文尼亚语', lit: '立陶宛语', lav: '拉脱维亚语', est: '爱沙尼亚语', ice: '冰岛语',
  heb: '希伯来语', ukr: '乌克兰语', hrv: '克罗地亚语', srp: '塞尔维亚语', cat: '加泰罗尼亚语', glg: '加利西亚语',
  baq: '巴斯克语', mac: '马其顿语', div: '迪维希语', msa: '马来语', tgl: '他加禄语', tam: '泰米尔语',
  tel: '泰卢固语', kan: '卡纳达语', mal: '马拉雅拉姆语', de: '德语', es: '西班牙语', id: '印尼语',
  ja: '日语', ko: '韩语', th: '泰语', vi: '越南语', 'pt-br': '葡萄牙语（巴西）', 'zh-cn': '中文（简）', 'zh-tw': '中文（繁）',
  // The tier a 468-file re-sample on 2026-10-26 still found printing as itself: `arm`/`geo`/`alb` are the
  // ISO-639-2/B spellings of three languages already above under their 639-2/T names, and `mul` is the
  // server's way of saying a track is not one language. `tc` is left alone — nothing in these replies
  // says what it means, and a guess would be worse than the code.
  aze: '阿塞拜疆语', arm: '亚美尼亚语', hye: '亚美尼亚语', geo: '格鲁吉亚语', kat: '格鲁吉亚语',
  kaz: '哈萨克语', khm: '高棉语', kir: '吉尔吉斯语', alb: '阿尔巴尼亚语', sqi: '阿尔巴尼亚语',
  srd: '撒丁语', mul: '多语言',
  // Dialects a track title can name while the Language field stays broad: 寒战's dubs come coded `chi`
  // titled 「Mandarin」, and Obsession's `mul` track is titled 「Swiss German, France」.
  cmn: '普通话', gsw: '瑞士德语',
  // The subtitle scene's two-letter script codes, measured 2026-10-26 on 鬼灭之刃 S01E05 (`tc` was the
  // one stream language left printing as itself): on a CJK release `sc`/`tc` are 简/繁 and nothing else.
  sc: '中文（简）', tc: '中文（繁）',
  // The 42 codes that still printed themselves as a track heading, 324 rows over the 131,741 subtitle and
  // 32,770 audio streams of both gateways' 23,027 files, measured 2026-10-27 (.probe/rc/gap-enumerate.txt).
  // Each is a real ISO-639-2 spelling of a language the standard names — the
  // servers spell them out in their own DisplayTitle (`nld`→Dutch ×16, `ell`→Greek ×15, `twi`→Twi ×15,
  // `ron`→Romanian ×14, `mon`→Mongolian ×12) — and the 639-2/T forms ride beside the 639-2/B ones
  // already above because one file carries both spellings as two rows.
  nld: '荷兰语', ell: '希腊语', ces: '捷克语', ron: '罗马尼亚语', slk: '斯洛伐克语', isl: '冰岛语',
  mkd: '马其顿语', ben: '孟加拉语', mar: '马拉地语', pan: '旁遮普语', zul: '祖鲁语', mon: '蒙古语',
  xho: '科萨语', yor: '约鲁巴语', per: '波斯语', nav: '纳瓦霍语', dzo: '宗卡语', epo: '世界语',
  sun: '巽他语', cha: '查莫罗语', guj: '古吉拉特语', bod: '藏语', wel: '威尔士语', bur: '缅甸语',
  twi: '阿肯语', dv: '迪维希语', nno: '挪威尼诺斯克语', zxx: '无语言内容',
  // Four the table answers for out of the row's own words rather than out of the code: `khk` is titled
  // 「Монгол」, `arc` is 耶稣受难记's only audio (the film is spoken in Aramaic), `phi` is titled
  // 「Filipino」 in a 25-subtitle roster whose Filipino seat is this row, and `tai` ×26 sits in the same
  // kind of platform roster (eng ind vie kor msa por ara spa jpn beside it) in files that carry no `tha`
  // row anywhere — the Thai seat, filled with the Tai-family collective code.
  khk: '蒙古语', arc: '阿拉米语', phi: '菲律宾语', tai: '泰语',
  // `zhs` is the scene's own spelling of 简: all 14 rows are MOV_TEXT tracks that share their file with a
  // `zht` one (狙击精英：孤魂野鬼 = Audio:eng + Subtitle:zhs + zht + eng), and the script is the only
  // thing telling the pair apart.
  zhs: '中文（简）',
  // Placeholders, not languages: `def` ×34 is the one audio track of a Chinese film with an empty title
  // (大蛇4：迷失世界, 小镇车神之五菱漂移, 大项目), `aud` ×3 and `dol` ×9 are named for what they are (audio)
  // and sit in files whose video is `und` with no other language either. Calling any of them a language
  // would invent one, so they say what `und` says.
  def: '无语言', aud: '无语言', dol: '无语言',
  // Two placeholders the row's own words do resolve: `dum` is titled 「Dutch Dolby Digital Audio 2.0
  // @ 448 kbps」 on a Dutch film's only audio (安东尼娅家族, beside Subtitle:eng + chi), and `guo` is 国语
  // — 墨攻's only audio, and 一条狗的回家路's Chinese dub beside its `eng` one.
  dum: '荷兰语', guo: '中文',
  // The language half of a locale written out as the whole title, which is how these files name a
  // variant: 「fr-FR」 ×101, 「it-IT」 ×97, 「ar-SA」 ×97, 「ru-RU」 ×95, 「pt-BR」 ×134, 「ms-MY」 ×23,
  // 「hi-Latn」 ×38 each left the code standing on the card beside a region the pass could already read.
  // Deliberately absent, because the same letters are doing a different job wherever else they appear as
  // a bare token: `ch` is 「Chinese 6 ch」 ×254 (a channel count), `us`/`my`/`uk` are regions (en-US
  // ×233, ms-MY ×23, English (UK) ×6), `hr` is DTS-HD HR, `he` is HE-AAC, `no` is the first word of
  // 「No linguistic content」, `la` is 「La Trobe University」 — so those read as a codec, a country or a
  // name, and never as a nationality.
  it: '意大利语', fr: '法语', ru: '俄语', ar: '阿拉伯语', ms: '马来语', hi: '印地语', pt: '葡萄牙语',
};

/** The one word for a track that carries no language, which every surface that names a track reaches for
 *  from here. Measured 2026-10-28 over both corpora: 3,551 of 32,770 audio rows and 243 of 130,957 embedded
 *  subtitle rows have neither a `Language` nor a `Title` that says anything — the card has always called
 *  those 无语言 (and `und`/`def`/`aud`/`dol` in the table below spell it that way), while the player's menu
 *  met them with a made-up 「轨道 1」, in 162 versions right beside a sibling that does name one, and its
 *  外挂 section used a third word (未标语言, 215 rows). One fact, three words, two surfaces of the same module. */
export const NO_LANG = '无语言';

/** A language tag with a subtag glued to it — `es-419`, `zh-HK`, `pt-BR`, `hi-Latn` — which is how Matroska
 *  stores a variant and how mpv hands the field straight back to the player's menu. The half a reader
 *  compares tracks by is the language; the subtag is the qualifier that belongs beside it, not inside the
 *  heading, because a cluster headed 「西班牙语」 and a cluster headed 「西班牙语（拉丁美洲）」 two words
 *  apart is one family shown twice. So `langName` answers the language half and the script or region word
 *  comes from the title through `zhTrackWords`. Measured 2026-10-27 over the 545 streams whose `Language`
 *  field carries a subtag at all: 507 are `zh-CN`/`zh-TW`/`zh-Hans`/`zh-Hant` — whose variant is the
 *  script, and both spellings of it are in the table — and the remaining 38 are `hi-Latn`, where the
 *  title says 「印地语 (forced)」 and the tag's other half reaches the card as 拉丁 anyway. */
export const langName = (code?: string): string => {
  if (!code) return '';
  const key = code.toLowerCase();
  if (key.startsWith('zh-hant')) return '中文（繁）';
  if (key.startsWith('zh-hans')) return '中文（简）';
  const named = LANGS[key];
  if (named) return named;
  // Two languages written into one field — 「chs&eng」, 「EN&CHT」 — is one subtitle carrying both, which is
  // what the card's own 双语 word is for. Both halves have to be known for the join to be read; a field
  // naming one language and one nothing stays the field.
  const joined = /^([a-z]{2,4})[&+]([a-z]{2,4})$/.exec(key);
  if (joined) {
    const a = LANGS[joined[1]];
    const b = LANGS[joined[2]];
    if (a && b) return `${a}/${b}`;
  }
  const half = /^([a-z]{2,3})[-_][a-z0-9]{2,4}$/.exec(key)?.[1];
  return (half && LANGS[half]) || code;
};
/** Whether a row's own words already say this language, so the surface printing beside it can stay quiet.
 *  Two spellings of one fact count: a sidecar titled 「简体」 under a `zh-cn` language has said 中文（简）,
 *  and the plain `includes` the player menu used to test missed exactly that and printed 「简体 中文（简）」. */
export const saidLang = (row: string, code?: string): boolean => {
  const lang = langName(code);
  if (!lang || !row) return false;
  if (row.includes(lang)) return true;
  const script = /^中文（(简|繁)）$/.exec(lang);
  return !!script && row.includes(`${script[1]}体`);
};

/** The one place a track's own words are turned into the reader's language. A release group names its
 *  tracks in whatever language it works in, and measured 2026-10-26 over 471 files / 3,124 subtitle
 *  streams both gateways answer with 544 labels a Chinese reader cannot read: the language's own
 *  spelling (Deutsch ×15, čeština, magyar, 한국어, ไทย, العربية), a region in that spelling (Português
 *  Brasil, Español Latinoamérica, Español España), an English region adjective (European ×18, Latin
 *  American ×16, Brazilian ×10), and SDH ×74. Every one of them restates or qualifies the language the
 *  row already heads in Chinese, so each word is resolved and re-said in Chinese here: language names in
 *  any of their spellings drop when they name the track's own language and become their Chinese name
 *  when they name another (Mandarin under a 中文 head is 普通话, which is news); region words become
 *  Chinese region names; SDH/CC become 听障. What no table can resolve — a format code (ASS, PGSSUB),
 *  a person's name in a commentary credit — rides along as it came, because a guess would be a lie.
 *  Returns '' when nothing survives, which is the caller's signal that the title said nothing the
 *  language heading does not already say. */
const EN_LANG = new Intl.DisplayNames(['en'], { type: 'language' });
const ZH_LANG = new Intl.DisplayNames(['zh-Hans'], { type: 'language' });
const ZH_REGION = new Intl.DisplayNames(['zh-Hans'], { type: 'region' });
export const enName = (code?: string): string => {
  if (!code) return '';
  try {
    return EN_LANG.of(code.toLowerCase()) || '';
  } catch {
    return '';
  }
};
export const zhName = (code?: string): string => {
  if (!code) return '';
  try {
    return ZH_LANG.of(code.toLowerCase()) || '';
  } catch {
    return '';
  }
};
/** Case, accents and punctuation are not facts about a language: `Intl` spells `nob` as 「Bokmål」 while
 *  the file spells it 「Bokmal」. One fold for every side of every compare below. */
export const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
/** `fold` erases every script but Latin, and that is exactly the spelling an endonym comes in — 「ไทย」,
 *  「한국어」, 「العربية」 — as well as a region named in its own country's words (ಭಾರತ). Those need a
 *  second key: the same string with case, spaces and punctuation off and the letters left alone. */
const rawKey = (s: string): string => s.normalize('NFC').toLowerCase().replace(/[\s\-_/.,:;()[\]{}（）「」]/g, '');
/** The locale a code's own speakers read it in — `de` for `ger`, `nb` for `nob` — which is where the
 *  endonym comes from: the title says 「Deutsch」 and only a German-locale DisplayNames call knows that
 *  is the German name of German. */
const LOCALE: Record<string, string> = {
  chi: 'zh', zho: 'zh', chs: 'zh', zht: 'zh', cht: 'zh', yue: 'zh', sc: 'zh', tc: 'zh', eng: 'en', en: 'en',
  jpn: 'ja', ja: 'ja', kor: 'ko', ko: 'ko', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', de: 'de', spa: 'es',
  es: 'es', ita: 'it', rus: 'ru', por: 'pt', tha: 'th', th: 'th', vie: 'vi', vi: 'vi', ind: 'id', id: 'id',
  may: 'ms', msa: 'ms', fil: 'fil', ara: 'ar', bul: 'bg', cze: 'cs', hun: 'hu', swe: 'sv', dut: 'nl',
  nld: 'nl', fin: 'fi', rum: 'ro', gre: 'el', hin: 'hi', tur: 'tr', nob: 'nb', nor: 'no', dan: 'da',
  pol: 'pl', slo: 'sk', slv: 'sl', lit: 'lt', lav: 'lv', est: 'et', ice: 'is', heb: 'he', ukr: 'uk',
  hrv: 'hr', srp: 'sr', cat: 'ca', glg: 'gl', baq: 'eu', mac: 'mk', div: 'dv', tgl: 'tl', tam: 'ta',
  tel: 'te', kan: 'kn', mal: 'ml', aze: 'az', arm: 'hy', hye: 'hy', geo: 'ka', kat: 'ka', kaz: 'kk',
  khm: 'km', kir: 'ky', alb: 'sq', sqi: 'sq', srd: 'sc', cmn: 'zh', gsw: 'gsw',
  // The codes the 2026-10-27 head census added to `LANGS`, each in the locale its own speakers read it
  // in — which is what makes 「Монгол」 a spelling of `khk` instead of a word no table knows.
  ell: 'el', ces: 'cs', ron: 'ro', slk: 'sk', isl: 'is',
  mkd: 'mk', ben: 'bn', mar: 'mr', pan: 'pa', zul: 'zu', mon: 'mn', khk: 'mn', xho: 'xh',
  yor: 'yo', per: 'fa', fas: 'fa', nav: 'nv', dzo: 'dz', epo: 'eo', sun: 'su', cha: 'ch', guj: 'gu',
  bod: 'bo', tib: 'bo', wel: 'cy', cym: 'cy', bur: 'my', mya: 'my', twi: 'ak', nno: 'nn', dv: 'dv',
  phi: 'fil', tai: 'th', zhs: 'zh', guo: 'zh', dum: 'nl', it: 'it', fr: 'fr', ru: 'ru', ar: 'ar',
  ms: 'ms', hi: 'hi', pt: 'pt',
};
const endonymCache = new Map<string, string>();
const endonym = (code: string): string => {
  const hit = endonymCache.get(code);
  if (hit !== undefined) return hit;
  let out = '';
  try {
    out = new Intl.DisplayNames([LOCALE[code] || code], { type: 'language' }).of(code) || '';
  } catch {
    out = '';
  }
  endonymCache.set(code, out);
  return out;
};
/** Spellings a title can carry for one language code: the English name, the Chinese one, the code and
 *  its aliases, and the endonym. 「Bahasa Indonesia」 is what an Indonesian release calls Indonesian
 *  while CLDR's id endonym is just 「Indonesia」, so the measured spellings ride beside the computed ones. */
const EXTRA_SPELLINGS: Record<string, string> = {
  'bahasa indonesia': 'ind', 'bahasa malaysia': 'may', 'bahasa melayu': 'may',
  // `Intl` answers 「Chinese」 for `cmn` in V8 and in Chromium alike, so the word a release group uses
  // for 普通话 — 6 audio tracks in the census, every one under a 中文 head where it is the only thing
  // telling two dubs apart — never resolves on its own. 国语 is the same track spelled in Latin.
  'mandarin': 'cmn', 'guoyu': 'cmn', 'putonghua': 'cmn',
  // A script of Chinese written as the language's own name instead of as a qualifier of it. CLDR spells
  // `zh-cn` as 中文（简）, so 「简体中文-SRT_(导演评论)字幕」 carries a word no computed spelling answers
  // for, and it rode onto the card untranslated under a 中文 heading that was already saying 中文. Cantonese
  // in its traditional spelling is the same gap: `Intl` answers 粤语 for `yue`, and the file said 粵語.
  '简体中文': 'zh-cn', '簡體中文': 'zh-cn', '繁体中文': 'zh-tw', '繁體中文': 'zh-tw', '粵語': 'yue',
  // Two the computed spellings miss because `Intl` answers in the wrong alphabet or the wrong reading:
  // the Serbian endonym comes back as 「српски」 while 招魂's subtitle is titled 「Srpski (Latinica)」,
  // and 蓝精灵's Korean PGS is titled 「Korenan-sup」 where every other table calls it 「한국어」.
  'srpski': 'srp', 'korenan': 'kor',
  // The two the server's own DisplayTitle still spells the old way — Emby answers 「Bengali」 (10 rows) and
  // 「Panjabi」 (6) where this runtime's CLDR says Bangla and Punjabi, so no computed spelling reaches the
  // card's word for them and the English name rode along beside 孟加拉语.
  'bengali': 'ben', 'panjabi': 'pan',
  // Four the after-pass of 2026-10-27 still found printing themselves — each is the language's own name in
  // a spelling no computed form produces. `nob`'s endonym comes back as 「norsk bokmål」 and its English
  // name as 「Norwegian Bokmål」, so the single word 「Bokmål」 that opens 309 DisplayTitles
  // (「Bokmål, Norwegian (SUBRIP)」) matched neither; `tha`'s comes back short (「ไทย」) while 23 titles
  // spell it out as 「ภาษาไทย」; `tgl` answers 「Filipino」 in both locales while 7 rows are titled
  // 「Tagalog」, the name this code had before ISO merged the two; and 「Modern Greek (1453-)」 is CLDR's
  // own long form of `gre`, 190 rows, where 「Greek」 alone already drops as the heading's echo and only
  // the adjective was left standing.
  'bokmål': 'nob', 'ภาษาไทย': 'tha', 'tagalog': 'tgl', 'modern greek': 'ell',
};
let LANG_SPELLINGS: Map<string, string> | null = null;
function langSpellings(): Map<string, string> {
  if (LANG_SPELLINGS) return LANG_SPELLINGS;
  const m = new Map<string, string>();
  const put = (spelling: string, code: string) => {
    for (const key of [fold(spelling), rawKey(spelling)]) if (key && !m.has(key)) m.set(key, code);
  };
  for (const code of Object.keys(LANGS)) {
    put(code, code);
    put(LANGS[code], code);
    put(enName(code), code);
    put(zhName(code), code);
    put(endonym(code), code);
  }
  for (const [spelling, code] of Object.entries(EXTRA_SPELLINGS)) put(spelling, code);
  LANG_SPELLINGS = m;
  return m;
}
/** Region adjectives have no region code of their own — 「European」 is not a place `Intl` can name — so
 *  the few the corpus holds map by hand onto the region that means them: 150 is Europe, 419 Latin America. */
const REGION_ADJ: Record<string, string> = {
  european: '150', 'latin american': '419', british: 'GB', castilian: 'ES', parisian: 'FR',
  metropolitan: 'FR', swiss: 'CH', brazilian: 'BR', canadian: 'CA',
  // The rest of the ones the 2026-10-27 census found still spelled in Latin on the card. `Turkey` ×45 is
  // the country CLDR puts beside `tr`, and beside a 土耳其语 heading it drops for saying nothing new;
  // `Hong Kong` ×351 and `HK` ×150 are the release's own region on a Chinese subtitle; `Latinoamericano`
  // ×24 is the Spanish spelling of the seat 「Latin American」 already holds; `American` ×20 and
  // `Egyptian` ×16 name the two variants of a language whose heading is the broad one.
  turkey: 'TR', 'hong kong': 'HK', hk: 'HK', latinoamericano: '419', american: 'US', egyptian: 'EG',
  // The four the same pass found on the other side of a language name: 嫁入黑帮's Arabic subtitle is
  // titled 「Egyptian」, 父债子偿's Spanish one 「Mexican Spanish」, 男孩、鼹鼠、狐狸和马's Dutch one
  // 「Flemish」, and 接近终点 puts its Castilian audio beside 「Castellano」. 「Taiwanese Mandarin」 is the
  // name 49 Chinese dubs (乐高蝙蝠侠大电影：DC英雄集结, 熊的传说, A计划…) give themselves, and only the
  // region word was missing for it to come out as 中国台湾 普通话 rather than 「Taiwanese 普通话」.
  mexican: 'MX', flemish: 'BE', castellano: 'ES', taiwanese: 'TW', taiwan: 'TW',
  // The same two-letter region tags a title writes instead of spelling the place out: 「English (UK)」 ×3
  // under a 英语 heading, where 英国 is news the heading does not carry, and 「USA」 ×1.
  uk: 'GB', usa: 'US',
};
/** A language tag written out as the whole title — 「Zh-hk [AAC 2.0]」 — where the language half is the
 *  heading and the region half is the only news. `zh-cn` and `zh-tw` are in `LANGS` already; these are
 *  the ones that are not, and each names a place rather than guessing which dialect was recorded. */
const LANG_TAG_REGION: Record<string, string> = { 'zh hk': 'HK', 'zh mo': 'MO', 'zh sg': 'SG', 'zh ch': 'CN' };
/** Words about a track that are not a language and not a place, in the reader's own words. SDH and CC
 *  are the same fact — subtitles for viewers who cannot hear the track — and 74 tracks carried one of them. */
const WORDS_ZH: [string, string][] = [
  ['audio descripition', '口述影像'], ['audio description', '口述影像'], ['closed captions', '听障'],
  // 「Visual Description」 ×53 is what the UK discs of 291771/12875/335 call the same narration track the
  // US discs call Audio Description — one service, two spellings on the label, so one word here. Leaving it
  // untranslated put 「Visual Description」 on a card that was otherwise all Chinese.
  ['visual description', '口述影像'],
  ['hearing impaired', '听障'], ['sdh', '听障'], ['cc', '听障'], ['commentary', '评论'],
  ['full', '完整'], ['original', '原声'], ['dubbed', '配音'], ['dub', '配音'], ['forced', '强制'],
  // A script, not a place: 搏击俱乐部's Serbian track is titled 「Latin」 for the alphabet it is set in.
  ['latin', '拉丁'],
  // The same fact in the shapes the corpus writes it, measured 2026-10-27: `Latn` is the subtag of all 38
  // 「hi-Latn」 rows; 改名换姓's Serbian subtitle is titled 「Cyrillic」 and 招魂's 「Srpski (Latinica)」,
  // which is the whole difference between the two files' one Serbian row; and a script word is the only
  // thing 35 rows have to say (22 of them under a 无语言 head). So it translates rather than drops.
  ['latn', '拉丁'], ['cyrillic', '西里尔'], ['cyrl', '西里尔'], ['latinica', '拉丁'],
  // `Hans`/`Hant` arrive as the subtag of a BCP-47 title 「zh-Hans」 where the language half is already the
  // heading, which left the script half untranslated beside it.
  ['hans', '简体'], ['hant', '繁体'],
  // What CLDR itself answers for a macrolanguage code (55 rows headed 马来语 carry the word 「macrolanguage」
  // and nothing else) and what a Portuguese release calls the European variety.
  ['macrolanguage', '语族'], ['iberian', '伊比利亚'],
  // What a French MULTI release calls its two dubs: VO the original, VFQ the Quebec one.
  ['vo', '原声'], ['vfq', '加拿大'],
  ['compatibility track', '兼容'], ['compatibility', '兼容'], ['track', ''], ['positional', ''],
  // Under a 中文 heading these two are not restating it — they are the script, which is the fact two
  // audio tracks of one Chinese film are told apart by, so they translate instead of dropping.
  ['simplified', '简体'], ['traditional', '繁体'],
  // A release group's own shorthand for the same two scripts, glued to whatever follows it: 「R3简中」 and
  // 「SUP简中字幕」 are 简体 tracks, and without these rows two of them on one file print as one 「中文×2」.
  ['简中', '简体'], ['繁中', '繁体'], ['簡中', '简体'],
  // The same two scripts in their traditional spelling, which is what a Cantonese or HK release writes:
  // 「粵語（繁體）」 came out as 「粤语 繁體」, one half translated and the other left in the script the
  // reader is not reading in.
  ['繁體', '繁体'], ['簡體', '简体'],
  // The same two scripts in the order a Chinese uploader writes them, language word first. Read as one
  // token, the head-drop below saw 中文 as its prefix and blanked the whole thing, so 科洛弗档案's two
  // subtitle rows — 「中文简体」 and 「中文繁体」 — printed as one 「中文×2」 and the choice the file
  // exists to offer disappeared. Measured 2026-10-27 over 131,741 subtitle tracks: 44 rows are that shape,
  // and this entry separates 19 pairs that had been printing one chip.
  ['中文简体', '简体'], ['中文繁体', '繁体'],
  ['简中字幕', '简体'], ['繁中字幕', '繁体'], ['字幕', ''],
  // The two words a LaserDisc-era rip puts where a subtitle's own name would be: 「Subtitle (PGS),
  // Japanese, 1474 captions」 ×21. Both are the heading the card already carries — the section is called
  // 字幕 — so both go, and what is left of that title is the number in front of `captions`, which the
  // count rule in `zhTrackWords` keeps: it is the only thing separating 196182's six clusters, where a
  // 1,474-line subtitle and a 10-line forced-only sidecar printed as one 「字幕」 chip.
  ['subtitle', ''], ['captions', ''], ['caption', ''],
  // Bit depth, spelled two ways inside a release's own spec string — 「… / 48 kHz / 1411 kbps / 24-bit」 —
  // measured 2026-10-27 on 20 audio rows, all 20 of which also carry the server's `BitDepth` field. The
  // 播放资源 card now prints that field as 24 位 beside the sample rate, so the word here is the same fact
  // a second time, in a script the reader is not reading.
  ['bit', ''], ['bits', ''],
  // 「Greek (Modern)」/「Modern Greek (1453-)」 ×190: the adjective is what separates these from the
  // ancient-Greek rows a handful of discs carry, so it survives as 现代 rather than as Latin.
  ['modern', '现代'],
  // Two dubs of one Japanese file, told apart by who is talking over it. They are the only words on those
  // tracks, so a card that could not read them would print two identical rows.
  ['キャストコメンタリー', '演员评论'], ['スタッフコメンタリー', '制作人员评论'],
];
/** Subtitle container names. They stay as codes on purpose — ASS and PGSSUB are the formats' own names,
 *  the way mkv and HEVC are elsewhere on the same card — but spelled the one way the card spells them.
 *  The three long keys are what mpv calls the same stream: measured 2026-10-28 by playing the one file per
 *  codec name both gateways send and matching mpv's track against the server's row by container stream
 *  number, mpv answers `hdmv_pgs_subtitle` where the server says `PGSSUB` (48 of the 127 tracks walked),
 *  `dvd_subtitle` for `DVDSUB`, and `webvtt-webm` for `webvtt`. Without them the player's menu would print
 *  HDMV_PGS_SUBTITLE beside a card that says PGS for one subtitle. */
const FORMAT: Record<string, string> = {
  srt: 'SRT', subrip: 'SRT', ass: 'ASS', ssa: 'SSA', pgssub: 'PGS', sup: 'PGS', pgs: 'PGS',
  hdmv_pgs_subtitle: 'PGS', dvd_subtitle: 'DVDSUB', 'webvtt-webm': 'VTT',
  vtt: 'VTT', webvtt: 'VTT',
};
/** One container's name on a card, from the codec the gateway reports. It is the same table `zhTrackWords`
 *  reads when a title carries the word itself, so the two routes agree on the spelling — and `subrip` and
 *  `srt` being one format with two names is what stops a title that already says 「SRT」 from being joined
 *  by a 「SUBRIP」 beside it. */
export const formatWord = (codec?: string): string => {
  const c = (codec || '').toLowerCase();
  // An unknown name is kept as the code, but spelled the way the title spells it: the tokenizer cuts
  // `mov_text` into two words, so a card whose title already said 简体 MOV TEXT compared it against
  // `MOV_TEXT`, failed, and appended the same format a second time (measured 2026-10-28 offline —
  // `dvb_teletext` has the same shape). Spaces are what a reader sees either way.
  return FORMAT[c] || (codec || '').toUpperCase().replace(/_/g, ' ');
};
/** Codec and channel vocabulary: words a track title borrows from the fields the row already prints
 *  (「English DTS-HD Master Audio 5.1 @ 3310 kbps」 over 「英语 · DTS · 5.1 · 3.3 Mbps」). A token matches
 *  with its trailing digits off, so DDP5.1 is DDP. */
const CODEC_WORDS = new Set([
  'dolby', 'digital', 'plus', 'ddp', 'dd', 'dts', 'hd', 'master', 'atmos', 'truehd', 'ac', 'ac3',
  'eac3', 'aac', 'pcm', 'lpcm', 'flac', 'express', 'surround', 's16le', 'with', 'audio', 'ch',
  'channels', 'kbps', 'mbps', 'hz', 'khz', 'stereo', 'mono', 'x', 'dtsx', 'adts', 'stripped',
]);
/** ISO 3166-1 alpha-2 plus the UN blocks a release group writes as a number (`Spanish 419`) or as the
 *  whole world (`العربية العالم` = Arabic, world). `Intl.supportedValuesOf('region')` is not in this
 *  runtime, so the code list is the constant it would have returned. */
const REGION_CODES = (
  'AD AE AF AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ CA CD CF CG CH ' +
  'CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GM GN ' +
  'GQ GR GT GW GY HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN KP KR KW KZ LA LB LC ' +
  'LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP ' +
  'NR NZ OM PA PE PG PH PK PL PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST ' +
  'SV SY SZ TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VN VU WS YE ZA ZM ZW ' +
  '001 002 005 009 011 013 014 015 017 018 019 021 029 030 034 035 039 053 054 057 061 142 143 145 ' +
  '150 151 154 155 202 419'
).split(' ');
const REGION_LOCALES = ['en', 'es', 'pt', 'fr', 'de'];
const regionIndexCache = new Map<string, Map<string, string>>();
/** Region names in the languages a release group writes them in, plus the track's own — 「Brasil」 is
 *  Portuguese, 「Latinoamérica」 Spanish, 「ಭಾರತ」 Kannada. Built on first need: a sheet whose titles are
 *  all Chinese never pays for it. */
function regionIndex(locale: string): Map<string, string> {
  const hit = regionIndexCache.get(locale);
  if (hit) return hit;
  const m = new Map<string, string>();
  const locales = [...REGION_LOCALES, locale];
  for (const loc of locales) {
    let dn: Intl.DisplayNames;
    try {
      dn = new Intl.DisplayNames([loc], { type: 'region' });
    } catch {
      continue;
    }
    for (const code of REGION_CODES) {
      let name = '';
      try {
        name = dn.of(code) || '';
      } catch {
        continue;
      }
      for (const key of [fold(name), rawKey(name)]) if (key && !m.has(key)) m.set(key, code);
    }
  }
  regionIndexCache.set(locale, m);
  return m;
}
const regionZh = (code: string): string => {
  // CLDR's zh-Hans names Taiwan bare while Hong Kong and Macau carry 中国; one island list should not
  // read as three countries' worth of regions.
  if (code === 'TW') return '中国台湾';
  // The same CLDR file spells Hong Kong and Macau out to 中国香港特别行政区 and 中国澳门特别行政区, which is
  // four times the width of every other region name on this card and says no more than the short form.
  if (code === 'HK') return '中国香港';
  if (code === 'MO') return '中国澳门';
  // Chromium's zh-Hans CLDR has no name for the UN block 150 and hands the code straight back, where the
  // same call in Node answers 欧洲 — measured 2026-10-26, and the difference put 「西班牙语 150」 on screen.
  if (code === '150') return '欧洲';
  try {
    const name = ZH_REGION.of(code) || '';
    // An unknown code comes back as itself, which on this card would read as a word nobody translated.
    return name === code ? '' : name;
  } catch {
    return '';
  }
};
/** A commentary credit is a fixed sentence around proper nouns: 「Commentary by director Robert
 *  Zemeckis, producer Steve Starkey, and production designer Rick Carter」. The roles translate, the
 *  names are names and stay. */
/** What a Chinese language name adds over the heading it sits under, when the addition is a script. */
const scriptOf = (rest: string): string => {
  const inner = rest.replace(/[（）()]/g, '');
  return inner === '简' ? '简体' : inner === '繁' ? '繁体' : inner;
};
const translateRoles = (s: string): string =>
  /commentary/i.test(s)
    ? s
        .replace(/production designer/gi, '美术指导')
        .replace(/\bdirector\b(?:\s*\/\s*(?:writer|editor)\b)+/gi, '导演/编剧/剪辑')
        .replace(/\bdirector\b/gi, '导演')
        .replace(/\bwriter\b/gi, '编剧')
        .replace(/\beditor\b/gi, '剪辑')
        .replace(/\bproducer\b/gi, '制片人')
        .replace(/\band\b/gi, '、')
        .replace(/,\s*/g, '、')
        .replace(/\bby\b/gi, ' ')
        .replace(/commentary/gi, '评论')
        .replace(/、\s+/g, '、')
        .replace(/、{2,}/g, '、')
        .replace(/\s{2,}/g, ' ')
        .trim()
    : s;

/** A track title with its brackets opened, for the pass below to read. Brackets become spaces rather than
 *  disappearing with their contents: 「Español (Latinoamérica) [SDH]」 and 「Español (España) [SDH]」 are two
 *  tracks whose only difference sits inside brackets, and 「Chinese(德加拉国配)」 is one whose difference is
 *  glued to a word the pass can read. The words themselves — SDH, simplified, a region — are the pass's job,
 *  not this function's: cutting them here is what once folded a Latino and a Castilian SDH track into one
 *  「听障」.
 *  The 播放资源 card and the player's subtitle menu both name their rows through this, so one track cannot
 *  read 巴西 葡萄牙语 on one surface and Brazilian Portuguese on the other. */
export const openBrackets = (t: string): string =>
  t.replace(/[（(\[]/g, ' ').replace(/[）)\]]/g, ' ').replace(/\s+/g, ' ').trim();

export const zhTrackWords = (title: string, code: string, keepFormats: boolean, keepRegions = false): string => {
  const head = langName(code);
  const spellings = langSpellings();
  const regions = regionIndex(LOCALE[code] || code || 'en');
  // A place the heading already names is the heading twice: 「Dansk (Danmark)」 under 丹麦语 says nothing a
  // reader lacks, while 「Latinoamérica」 under 西班牙语 is the one word telling two SDH tracks apart — so
  // only an overlap with the heading drops, and a region beside it stays. The overlap test cannot see the
  // row beside this one, so the caller that clusters tracks says when the region is the difference:
  // `keepRegions` reads it back out of the title it came from.
  const regionWord = (r: string): string => {
    const rz = regionZh(r);
    return !keepRegions && head && rz && (head.startsWith(rz) || rz.startsWith(head)) ? '' : rz;
  };
  // 「CHS&ENG」 is not two languages, it is one subtitle carrying two. 非常嫌疑犯 keeps six Chinese tracks
  // whose only differences are the script and this join — CHS(英语) beside CHS&ENG(英语) — and with the
  // join read as the separator it is, the pair printed as one 「简体 英语×2」. It is resolved here, on the
  // raw title, because the split below cannot see it; and only where both halves are languages, so a credit
  // (「Smith & Jones」) and a French MULTI's 「VO/VFQ」 keep every word they came with.
  const bilingual = (t: string): string =>
    t.replace(/([A-Za-z]{2,6})\s*[&+]\s*([A-Za-z]{2,6})/g, (m, a: string, b: string) => {
      const ka = fold(a);
      const kb = fold(b);
      return ka && kb && ka !== kb && spellings.has(ka) && spellings.has(kb) ? `${a} 双语` : m;
    });
  // The separators are not words: 「Eng/SUP」, 「guoyu_cmfa4hd4_51」 and 「English-DD_5.1」 carry their
  // parts glued together, and every part has an entry of its own below. A bracket is a separator too, and
  // a load-bearing one — 阿甘正传's five audio tracks are 「Chinese(德加拉国配)-DD_5.1」 and its sibling
  // 「Chinese(央视国配)-DD_5.1」, where the only word telling them apart sits inside brackets glued to a
  // word `fold` can read. Left glued, the Latin half matches the heading and takes the Chinese name down
  // with it, and the two rows print identically.
  const tokens = translateRoles(bilingual(title || ''))
    // A script word glued to a format code is two words wearing one coat: 「简体ASS」 and 「R3简中」 came in
    // as single tokens, so the script half never reached a table and the whole token was dropped as noise —
    // which is how 简体ASS and 繁体ASS, the only difference between two tracks, became one 「中文×2」.
    .replace(/([㐀-鿿　-〿぀-ヿ])([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9])([㐀-鿿　-〿぀-ヿ])/g, '$1 $2')
    .replace(/[（(\[]/g, ' $& ')
    .replace(/[）)\]]/g, ' $& ')
    .split(/[\s\-_/&|]+/)
    .filter(Boolean);
  // A token the fold cannot see — 「德加拉国配」, 「ไทย」 — is one no Latin key can stand for, so a
  // multi-token match that spans it would be claiming words it never read: `fold` turns
  // 「Chinese ( 德加拉国配 )」 into plain `chinese`, which is the heading, and the name that made the
  // track itself goes with it. Those tokens are matched one at a time, on their own spelling.
  const blind = tokens.map(t => !fold(t) && !!rawKey(t));
  const out: string[] = [];
  // One word said twice is not a second fact — and the guard this pass used to have against it sat on the
  // translating branch only, so the branch that hands back the file's own words never met it. Measured
  // 2026-10-27 over 131,741 subtitle tracks in 23,027 sources: 1,282 chips printed one script word twice,
  // because `chs` came back as 简体 and the title went on to say 简体 in Chinese — 「Chs/SUP  简体」 read
  // 「简体 简体」, 「Cht/SUP  原盘繁体(HK)」 read 「繁体 原盘繁体 中国香港」, 「Chs/SUP Netflix官译简体中文」
  // read 「简体 Netflix 官译简体中文」. Two Chinese words one inside the other are the same fact at two
  // lengths: the longer takes the floor and the shorter leaves. Latin is barred from both tests — a residue
  // no table knows prints word for word exactly as the file wrote it.
  const say = (w: string): void => {
    // A word that carries Latin is a credit's own phrasing, and prose repeats words for a reason — so it
    // only loses a repeat of the word immediately behind it, which is what this pass did before.
    if (fold(w)) {
      if (out[out.length - 1] !== w) out.push(w);
      return;
    }
    if (out.includes(w)) return;
    if (w.length > 1 && out.some((p) => p.length > 1 && !fold(p) && p.includes(w))) return;
    if (w.length > 1) {
      for (let j = out.length - 1; j >= 0; j--) {
        const p = out[j];
        if (p.length > 1 && !fold(p) && w.includes(p)) out.splice(j, 1);
      }
    }
    out.push(w);
  };
  for (let i = 0; i < tokens.length; ) {
    const tok = tokens[i];
    // Punctuation the split left standing — the 「@」 of a bitrate, the colon of 「VFQ : Full」, and the
    // brackets of 「粵語（繁體）」 in either script. Tested as punctuation rather than as ASCII because a
    // Chinese or Japanese token folds to nothing too and is a word, not a separator.
    if (/^[\p{P}\p{S}]+$/u.test(tok) && !fold(tok)) {
      i++;
      continue;
    }
    const rest = tokens.slice(i);
    const joined = (n: number) => fold(rest.slice(0, n).join(' '));
    const joinedRaw = (n: number) => rawKey(rest.slice(0, n).join(' '));
    // Longest match first: 「Latin America」 is one region, not an adjective plus a continent.
    let took = 0;
    let said = '';
    for (let n = Math.min(rest.length, 4); n >= 1 && !took; n--) {
      if (n > 1 && blind.slice(i, i + n).some(Boolean)) continue;
      const k = joined(n);
      const kr = joinedRaw(n);
      if (!k && !kr) continue;
      // Two letters that are both a language code and a region code — `IT`, `RU`, `PT` — are the place when
      // they come in all caps and the language when they come in lower case, which is exactly how a title
      // writes the two halves of 「it-IT」 and 「ru-RU」. The uppercase-only test is the same one that keeps
      // 「Chinese 6 ch」 from reading as Chamorro and a commentary's 「is」 from reading as Icelandic.
      const regionFirst = n === 1 && /^[A-Z]{2}$/.test(tok) && REGION_CODES.includes(tok);
      const langRaw = regionFirst ? '' : (k && spellings.get(k)) || spellings.get(kr);
      // `sc` and `tc` are the subtitle scene's 简/繁 — but `sc` is also ISO's Sardinian, and a row of
      // that language titled 「sc-IT」 is a region, not a claim about Chinese script. The two-letter
      // script codes are read as a language only where a CJK heading (or no heading at all) makes that
      // the plain reading.
      const lang =
        (langRaw === 'sc' || langRaw === 'tc') && head && !/中文|粤语|日语|韩语/.test(head) ? '' : langRaw;
      if (lang) {
        const zh = langName(lang);
        took = n;
        // The track's own language, in any spelling, is the heading saying itself a second time. A
        // heading of bare 中文 over a title saying 中文（简） keeps the half that is news; a track with no
        // language at all keeps the name, since nothing down there is saying it yet.
        said = !head
          ? zh
          : zh === head || head.startsWith(zh)
            ? ''
            : zh.startsWith(head)
              ? scriptOf(zh.slice(head.length))
              : zh;
        continue;
      }
      const adj = REGION_ADJ[k] || LANG_TAG_REGION[k] || REGION_ADJ[kr] || LANG_TAG_REGION[kr];
      if (adj) {
        took = n;
        said = regionWord(adj);
        continue;
      }
      const region = (k && regions.get(k)) || regions.get(kr);
      if (region) {
        took = n;
        said = regionWord(region);
        continue;
      }
      // An entry can translate to nothing — 「字幕」 on a row that is already a subtitle, 「Positional」 on
      // an audio track — and that empty string is an answer, not a miss. Truthiness here dropped the word
      // back into `out` untranslated, so 「SDH / Positional / PGS」 kept its English half beside the
      // Chinese one it did resolve.
      const hit = WORDS_ZH.find(([w]) => w === k || w === kr);
      if (hit) {
        took = n;
        said = hit[1];
        continue;
      }
      if (n === 1) {
        // The gateway writes its own Chinese for the heading's language inside the title — 「Czech (捷克文)」
        // under 捷克语, 「English [英文]」 under 英语 — and it ends that word in 文 where CLDR ends it in 语, so
        // no table here recognises the token and the heading came back said twice in two spellings.
        // Measured 2026-10-27 over 3,176 subtitle tracks: 33 labels ended that way, 14 of them 「英文」.
        // Normalising the last character makes the echo visible — and what sits in front of it is the news,
        // which is the whole difference between two tracks: 巴西葡萄牙文 beside 葡萄牙文 is 巴西, and
        // 原碟英文 under an 英语 heading is 原碟.
        if (head && blind[i]) {
          const norm = tok.replace(/文$/, '语');
          if (norm === head || head.startsWith(norm) || norm.startsWith(head)) {
            took = 1;
            said = '';
            continue;
          }
          if (norm.endsWith(head)) {
            took = 1;
            said = norm.slice(0, norm.length - head.length);
            continue;
          }
        }
        const fmt = FORMAT[k];
        if (fmt) {
          took = 1;
          said = keepFormats ? fmt : '';
          continue;
        }
        // A place written as its own code — 「Spanish 419」 — where `Intl` knows the name and not the
        // code. Uppercase only, so 「in」 or 「no」 inside a commentary credit is not India or Norway.
        if (/^[A-Z0-9]{2,3}$/.test(tok) && REGION_CODES.includes(tok)) {
          took = 1;
          said = regionWord(tok);
          continue;
        }
        // The one number these rips write that no field of the reply carries: the cue-line count in
        // 「Subtitle (PGS), Japanese, 1474 captions」. Dropped with every other bare number it left the
        // title saying nothing, and 196182's 21 PGS rows printed 13 「字幕」 chips — six of them over two
        // tracks whose counts differed (日 1474↔10, 法 1457↔9, 意 1637↔21, 德 1637↔21, 俄 1639↔8,
        // 西 1638/1628/41/6, where a 6-line track is forced captions and nothing else). Paired with the
        // word that makes it a count it stays, in the reader's own unit.
        if (/^\d[\d,]*$/.test(tok) && /^(caption|captions|caps)$/.test(fold(tokens[i + 1] || ''))) {
          took = 2;
          said = `${tok.replace(/,/g, '')} 行`;
          continue;
        }
        // The numbers and codec words the row's own fields already print, with whatever punctuation the
        // split left on them: 「5.1]」 is 5.1 and 「[Dolby」 is Dolby.
        const bare = k.replace(/[^a-z0-9]/g, '');
        if (CODEC_WORDS.has(bare) || CODEC_WORDS.has(bare.replace(/\d+$/, '')) || /^\d+$/.test(bare)) {
          took = 1;
          said = '';
          continue;
        }
        // An encoder's own token rather than a word — 「cmfa4hd4」, 「hd2」, 「10bit」 — which no table in
        // here has and no reader on this card is looking for.
        if (/^[a-z]+\d+[a-z0-9]*$/.test(bare) || /^\d+[a-z]+$/.test(bare) || /^[a-z]$/.test(bare)) {
          took = 1;
          said = '';
          continue;
        }
      }
    }
    if (took) {
      if (said) say(said);
      i += took;
    } else {
      // A token no table knows goes out as the file wrote it.
      say(tok);
      i++;
    }
  }
  const z = out.join(' ').replace(/\s{2,}/g, ' ').trim();
  // 「挪威语」 left over under a 挪威语 heading is the heading twice, and the fold is what catches the
  // spelling the file used for it. A result written in Chinese folds to nothing, so the fold only counts
  // when it says something: 听障 under a 英语 heading is the whole point of the pass and is not the
  // heading twice, however empty both sides look to `fold`.
  return z && z !== head && !(fold(z) && fold(z) === fold(head)) ? z : '';
};

/** Half the episodes on this server have no title of their own and come named 「第 2 集」, 「27」 or
 *  「Episode 3」 - which the position in front of them already says. `episodeTail` is the surface rule;
 *  this is the one it finishes on. */
const isPositionOnlyName = (name: string): boolean => {
  const t = name.trim();
  return /^第\s*[\d一二三四五六七八九十百千]+\s*[集话話]\s*$/.test(t) || /^\d+$/.test(t) || /^episode\s*\d+$/i.test(t);
};

/** Where a name spells its own position: each pattern yields the season (null when it names none) and the
 *  episode it claims. `(?<!\d)`/`(?!\d)` keep a resolution out of the list — 「1920x1080」 is not 20x108.
 *  Four digits on the episode because the long-running shows here are past 999: 名侦探柯南 rows come named
 *  「名侦探柯南 - S01E1277」, and a three-digit cap read no code at all, so the release group's label stayed
 *  on the card. The resolution pattern keeps its three — a 4-digit tail there is the picture, not an episode. */
const POSITION_CODES: [RegExp, (m: RegExpMatchArray) => [number | null, number]][] = [
  [/s(?:eason)?\s*(\d{1,2})[\s._\-–—x]*e(?:p(?:isode)?)?\s*(\d{1,4})(?!\d)/i, m => [+m[1], +m[2]]],
  [/(?<!\d)(\d{1,2})\s*[x]\s*(\d{1,3})(?!\d)/, m => [+m[1], +m[2]]],
  [/第\s*(\d{1,2})\s*季\s*第\s*(\d{1,4})\s*[集话話]/, m => [+m[1], +m[2]]],
  [/\bep\.?\s*(\d{1,4})\b/i, m => [null, +m[1]]],
  [/#\s*(\d{1,4})(?!\d)/, m => [null, +m[1]]],
  [/第\s*(\d{1,4})\s*[集话話]/, m => [null, +m[1]]],
  [/[【[(（]\s*(\d{1,4})\s*[】)\]）](?!\d)/, m => [null, +m[1]]],
];

/** What an episode's own name adds beyond the position the card already prints. Measured over the 3681
 *  episode rows both censuses pulled: 647 are 「第 57 集」 (the number alone), 51 more are 「ゆるキャン△ -
 *  S01E06」 (the number wearing the show's name), and 12 are 「第 3 集 鬼迷心窍」 (the number in front of a
 *  real title). A code is dropped only where it agrees with the row's own numbers, so a file named for a
 *  different episode keeps its words, and only what a drop leaves behind can be dropped for being the
 *  show's own name — 迷雾 第 16 集 and 都市男女爱情法 第 1 集 are episodes genuinely called that. */
const episodeTail = (name: string, season?: number | null, episode?: number | null, seriesName?: string): string => {
  let t = (name || '').trim();
  if (!t) return '';
  if (episode == null && season == null) return isPositionOnlyName(t) ? '' : t;
  const show = (seriesName || '').trim();
  const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
  for (let pass = 0; pass < 4; pass++) {
    let cut = false;
    for (const [code, read] of POSITION_CODES) {
      const m = t.match(code);
      if (!m || m.index == null) continue;
      const [cs, ce] = read(m);
      if (ce !== episode || (cs != null && season != null && cs !== season)) continue;
      t = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).trim();
      cut = true;
      break;
    }
    // A name no code was taken out of is the episode's own and leaves as it came - the trimming below
    // would eat the brackets of 「[VCB-Studio] Yuru Camp [CM][Ma10p_1080p]」 for nothing.
    if (!cut) break;
    // Only the dangling ends of the cut come off - separators and a bracket the code emptied.
    t = t
      .replace(/[（(\[【]\s*[)）\]】]/g, ' ')
      .replace(/^\s*(?:[-–—·・:：|｜,，、/\\]\s*)+/, '')
      .replace(/\s*(?:[-–—·・:：|｜,，、/\\]\s*)+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t || (show && same(t, show))) return '';
  }
  return t && !isPositionOnlyName(t) ? t : '';
};

/** A season's name is worth printing only for what it says beyond its number, and several sources may
 *  hold a name for the same season: this library's own rows come first, then TMDB's, and the first one
 *  that says anything more than the position wins. Measured here: 「第1季 立志篇」 and 「最终季」 name the
 *  season the viewer is choosing, while 「季 3」, 「Season 1」 and the 「シーズン 12」 物语系列 files fourteen
 *  of its seasons under just spell the position a second way and are dropped — and 鬼灭's server rows say
 *  only 「第 1 季」, where TMDB has the 「立志篇」 the server never filled in. */
export const seasonTitle = (season?: number | null, ...names: (string | undefined)[]): string => {
  const beyond = (name?: string): string =>
    (name || '')
      .trim()
      .replace(/^第\s*[\d一二三四五六七八九十百千]+\s*[季部]\s*[:：\-·]?\s*/, '')
      .replace(/^(season|季|シーズン)\s*\d+\s*[:：\-·]?\s*/i, '')
      .trim();
  const sub = names.map(beyond).find(Boolean) || '';
  if (season == null) return names.map(x => (x || '').trim()).find(Boolean) || '';
  // TMDB files specials, OVA and 总集篇 as season 0; 「第 0 季」 is not a season anyone counts, so the row's
  // own name is printed bare.
  if (season === 0 && sub) return sub;
  return sub ? `第 ${season} 季 · ${sub}` : `第 ${season} 季`;
};

/** One episode's headline inside a season the page has already named above it: the number the row is
 *  ordered by, then what the episode is actually called. The 「第 1 季」 half used to sit here too and spent
 *  the line's whole width restating the season that is open, once per card.
 *  `episodeName` is the ladder this prints after, so a surface that already owns its own position wording
 *  (the 在看 card, which says the season too) can take the name without the number twice. */
export const episodeName = (
  at: { episode?: number | null; season?: number | null; seriesName?: string },
  ...names: (string | undefined)[]
): string => names.map(n => episodeTail(n || '', at.season, at.episode, at.seriesName)).find(Boolean) || '';

export const episodeHead = (
  at: { episode?: number | null; season?: number | null; seriesName?: string },
  ...names: (string | undefined)[]
): string => {
  const pos = at.episode == null ? '' : `第 ${at.episode} 集`;
  const named = episodeName(at, ...names);
  return pos && named ? `${pos} · ${named}` : pos || named;
};

/** 「45分钟」 / 「1小时42分钟」 / 「2小时」 from whole minutes. The shape follows the length: under an hour
 *  there is nothing to split, over one the hours are said out loud, and an exact number of hours prints
 *  without a 「0分钟」 tail. The server bills a file in ticks and TMDB bills an episode in minutes, and a
 *  surface must be able to print either without two spellings of the same length — or, as this line used to
 *  read on the work page, 102 minutes of a film as 「102 分钟」 beside the detail page's 「1小时42分」. */
export const fmtMinutes = (mins?: number): string => {
  const m = Math.round(Number(mins) || 0);
  if (!m) return '';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (!h) return `${m}分钟`;
  return rest ? `${h}小时${rest}分钟` : `${h}小时`;
};

export const fmtRuntime = (ticks?: number): string => {
  const ms = ticksToMs(ticks);
  if (!ms) return '';
  return fmtMinutes(Math.round(ms / 60000));
};

/** How big a file is, in the unit its own number asks for. The 播放资源 card and the player's 播放源
 *  popover each carried a spelling of this and they disagreed — the popover divided by 1024³ and always
 *  said GB, so a 3 MB 特别篇 read 「0.00 GB」 — and one file's size is not two facts. */
export const fmtSize = (n?: number): string => {
  if (!n) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  const mb = n / 1e6;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`;
};
/** A rate rounded to 「0.2 Mbps」 is one significant figure standing in for 192 or 208 kbps, so under a
 *  megabit the number is stated in kilobits — which is where audio bitrates actually live. */
export const fmtRate = (n?: number): string => (!n ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} Mbps` : `${Math.round(n / 1e3)} kbps`);

/** The gateway's own word for a file's dynamic range, as a card says it. Measured 2026-10-27 over 480
 *  sources: 359 `SDR`, 64 `HDR 10` — with the space, which is how this gateway spells HDR10 — 56
 *  `DolbyVision`, and one that answers nothing at all. That one is not SDR: the strip defaulted to it, and
 *  a value painted on in the absence of an answer is the same lie the ✓ and the green dot were. */
const RANGE_CN: Record<string, string> = { SDR: 'SDR', 'HDR 10': 'HDR10', HDR10: 'HDR10', DolbyVision: '杜比视界' };
export const rangeWord = (range?: string): string => (!range ? '' : RANGE_CN[range] || range);

/** Which decoder mpv says it is actually using, in the letters the panel's own chips use. The chips offer
 *  `d3d11va` as 「D3D11」 while the row underneath printed the driver key, so one card said D3D11 and
 *  d3d11va about the same file; `no` is mpv's own word for software decoding. A `-copy` variant is still
 *  that driver — the suffix says where the frames land, not who decoded them — and an answer that is not
 *  this build's keeps its letters rather than being called 软解. Empty means nothing has reported yet,
 *  which is not the same claim as 软解. */
export const decoderWord = (v?: string): string => {
  const d = (v || '').toLowerCase().replace(/-copy$/, '');
  if (!d) return '';
  if (d === 'no') return '软解';
  if (d.startsWith('auto')) return '自动';
  if (d.startsWith('d3d11')) return 'D3D11';
  if (d.startsWith('dxva2')) return 'DXVA2';
  if (d === 'cuda' || d.startsWith('nvdec')) return 'CUDA';
  if (d === 'vaapi') return 'VAAPI';
  if (d === 'vdpau') return 'VDPAU';
  if (d.startsWith('videotoolbox')) return 'VideoToolbox';
  return d.toUpperCase();
};

/** The colour matrix as the standard writes it. Two vocabularies reach this: mpv's `video-params/colormatrix`
 *  spells the ITU-R key with a dot and a dash (`bt.709`, `bt.2020-ncl`), the server's `ColorSpace` field spells
 *  ffmpeg's enum without them (`bt709`, `bt2020nc`) — measured 2026-10-28 against the live mpv pipe. They are
 *  the same six names, so the lookup drops the punctuation and both arrive at one word. The `c`/`nc` suffix is
 *  the one part worth saying in the reader's own words: it says whether chroma is held constant. */
const COLORSPACE_CN: Record<string, string> = {
  bt709: 'BT.709', bt601: 'BT.601', bt601p: 'BT.601', bt601e: 'BT.601', bt470bg: 'BT.470BG',
  smpte170m: 'SMPTE 170M', bt170m: 'SMPTE 170M', smpte240m: 'SMPTE 240M', bt1361e: 'BT.1361E',
  bt2020: 'BT.2020',
  bt2020cl: 'BT.2020 恒定色度', bt2020c: 'BT.2020 恒定色度', bt2020ncl: 'BT.2020 非恒定色度', bt2020nc: 'BT.2020 非恒定色度',
  fcc: 'FCC', rgb: 'RGB',
};
/** `dolbyvision` is a value mpv's `colormatrix` carries — measured on the live pipe 2026-10-28 — and it names
 *  the Y′CbCr matrix, not the primaries, so it is not an answer to 色彩空间. It also says over again what the
 *  这条片源 line above it already says. The row draws its dash rather than print either. */
const NOT_A_COLORSPACE = new Set(['dolbyvision']);
export const colorSpaceWord = (v?: string): string => {
  const c = (v || '').toLowerCase().replace(/[.\-\s]/g, '');
  // `unknown` is what both spell the absence of a signal, and it is the dash the row already draws.
  if (!c || c === 'unknown' || c === 'unspecified' || NOT_A_COLORSPACE.has(c)) return '';
  return COLORSPACE_CN[c] || c.toUpperCase();
};

export const fmtDate = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 入库时间 reads as a full stamp: 「2025年4月6日 02:39」. */
export const fmtDateTime = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
};

/** What one of this machine's servers is called. The name typed here comes first because every gateway
 *  answers with 「OkEmby」 as its own server name, and two of them have to be told apart; the host is what
 *  is left when neither was ever filled in. The rail's account row and a card's corner badge both read
 *  through here, so the same server never carries two spellings. */
export const accountName = (a: { label?: string; serverName?: string; baseUrl: string }): string =>
  a.label || a.serverName || a.baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
