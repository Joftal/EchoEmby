/** The one table that spells a track's ISO-639-2 code the way a viewer reads it, and the one place a
 *  language code is reduced to the key two tracks are compared by.
 *
 *  It lives in `shared` because two processes need it: the renderer names a track («日语», «无语言») on the
 *  技术信息 card, in the player's 轨道面板 and in the 资源库 filter, while the main process has to *match* the
 *  首选语言 setting against the streams the server describes before mpv has opened anything. Keeping one copy
 *  is the point: a matched track and the word printed beside it must never be able to disagree.
 *
 *  The keys below are what these gateways answer with, measured over 1,600 files (the newest 400 plus the
 *  first 400 by name on each) and topped up from a 468-file sample on 2026-10-26 and a 1273-stream census on
 *  2026-10-29; a code the table does not know prints as itself rather than as a guess. Both spellings ride
 *  along where a gateway uses ISO-639-2/B (`ice` for Icelandic, `slo` for Slovak, `baq` for Basque, `mac`
 *  for Macedonian), because 蜘蛛侠：崭新之日 carries `slo` and `slv` as two different subtitle tracks in one
 *  file, so reading `slo` as Slovenian would name one language twice. */
export const LANGS: Record<string, string> = {
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
  // Two-letter codes, which the servers answer with only for scene releases (sc/tc above) but mpv hands
  // back verbatim from the container's own tag: 死神来了2's 6-track file names its Polish dub "pl" in
  // Matroska, and the panel printed 「pl」 beside 「英语」「俄语」. ISO-639-1 is the same list for every muxer,
  // so it is spelled out once here instead of being guessed per row. The letters the block above
  // deliberately left alone (he = HE-AAC, no = No linguistic content, hr = DTS-HD HR, la = La Trobe,
  // ch = 6 ch, us/my/uk = regions) are still absent: those are words a title borrows, not languages.
  pl: '波兰语', nl: '荷兰语', sv: '瑞典语', fi: '芬兰语', da: '丹麦语', hu: '匈牙利语', cs: '捷克语',
  el: '希腊语', sr: '塞尔维亚语', bg: '保加利亚语', ro: '罗马尼亚语', sk: '斯洛伐克语', sl: '斯洛文尼亚语',
  lt: '立陶宛语', lv: '拉脱维亚语', et: '爱沙尼亚语', is: '冰岛语', fa: '波斯语', ca: '加泰罗尼亚语',
  gl: '加利西亚语', af: '南非荷兰语', sw: '斯瓦希里语', eu: '巴斯克语', sq: '阿尔巴尼亚语', bs: '波斯尼亚语',
  mk: '马其顿语', be: '白俄罗斯语', ka: '格鲁吉亚语', hy: '亚美尼亚语', az: '阿塞拜疆语', kk: '哈萨克语',
  uz: '乌兹别克语', mn: '蒙古语', km: '高棉语', lo: '老挝语', ne: '尼泊尔语', si: '僧伽罗语', ur: '乌尔都语',
  ta: '泰米尔语', te: '泰卢固语', ml: '马拉雅拉姆语', kn: '卡纳达语', mr: '马拉地语', bn: '孟加拉语',
  pa: '旁遮普语', gu: '古吉拉特语', am: '阿姆哈拉语', so: '索马里语', ha: '豪萨语', ig: '伊博语',
  yo: '约鲁巴语', zu: '祖鲁语', cy: '威尔士语', ga: '爱尔兰语', mt: '马耳他语', lb: '卢森堡语',
  fo: '法罗语', tt: '鞑靼语', ba: '巴什基尔语',
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

/** Every spelling of one language folded onto one key, so a setting a viewer picked out of a list can be
 *  compared against a code a muxer wrote. The census of 2026-10-29 over both gateways' newest 80 films and
 *  episodes — 1,273 audio and subtitle rows — answered with 34 spellings and not one two-letter code, and
 *  they split three ways for the same six languages: ISO-639-2/B (`chi`, `fre`, `ger`, `dut`, `cze`,
 *  `gre`, `rum`), ISO-639-2/T (`zho`, `fra`, `deu`, `nld`, `ces`, `ell`, `ron`) and a full locale
 *  (`zh-CN` 15, `zh-TW` 15). Matching on the raw field would have found the Chinese track of 15 files and
 *  missed the 233 rows that say `chi`. mpv answers with the container's own tag verbatim (`pl` for Polish,
 *  `chi` for Chinese), so the two-letter side is read here too.
 *
 *  A code the alias table does not know folds to itself: 「波斯语」 picked from the list still matches a
 *  `per` row and not a `fas` one, which is the honest limit of a table, not a silent guess. No language at
 *  all answers null — `und`, `mul`, and the three placeholders `def`/`aud`/`dol` the servers fill an empty
 *  field with — because «prefer 无语言» is not something a viewer means, and a file whose only track says
 *  `und` must keep mpv's own answer rather than be forced onto a track nobody labelled. */
const ALIAS: Record<string, string> = {
  zho: 'chi', chi: 'chi', zh: 'chi', chs: 'chi', zht: 'chi', cht: 'chi', cmn: 'chi', guo: 'chi', sc: 'chi', tc: 'chi', zhs: 'chi',
  yue: 'yue',
  eng: 'eng', en: 'eng', jpn: 'jpn', ja: 'jpn', kor: 'kor', ko: 'kor',
  fre: 'fre', fra: 'fre', fr: 'fre', ger: 'ger', deu: 'ger', de: 'ger',
  spa: 'spa', es: 'spa', ita: 'ita', it: 'ita', por: 'por', pt: 'por', rus: 'rus', ru: 'rus',
  ara: 'ara', ar: 'ara', ind: 'ind', id: 'ind', may: 'may', msa: 'may', ms: 'may',
  tha: 'tha', th: 'tha', tai: 'tha', vie: 'vie', vi: 'vie', pol: 'pol', pl: 'pol',
  tur: 'tur', tr: 'tur', dut: 'dut', nld: 'dut', nl: 'dut', swe: 'swe', sv: 'swe',
  dan: 'dan', da: 'dan', nor: 'nor', nob: 'nor', nno: 'nor', fin: 'fin', fi: 'fin',
  cze: 'cze', ces: 'cze', cs: 'cze', hun: 'hun', hu: 'hun', gre: 'gre', ell: 'gre', el: 'gre',
  heb: 'heb', he: 'heb', ukr: 'ukr', uk: 'ukr', fil: 'fil', phi: 'fil', tgl: 'tgl',
  hin: 'hin', hi: 'hin', bul: 'bul', bg: 'bul', rum: 'rum', ron: 'rum', ro: 'rum',
  slo: 'slo', slk: 'slo', sk: 'slo', slv: 'slv', hrv: 'hrv', srp: 'srp', cat: 'cat', glg: 'glg',
  baq: 'baq', eu: 'baq', mac: 'mac', mkd: 'mac', mk: 'mac', ice: 'ice', isl: 'ice', is: 'ice',
  lit: 'lit', lt: 'lit', lav: 'lav', lv: 'lav', est: 'est', et: 'est',
  tam: 'tam', ta: 'tam', tel: 'tel', te: 'tel', kan: 'kan', kn: 'kan', mal: 'mal', ml: 'mal',
  ben: 'ben', bn: 'ben', mar: 'mar', mr: 'mar', pan: 'pan', pa: 'pan', urd: 'urd', ur: 'urd',
  ne: 'ne', si: 'si', km: 'khm', khm: 'khm', lo: 'lo', mn: 'mon', mon: 'mon', kk: 'kaz', kaz: 'kaz',
  uz: 'uz', az: 'aze', aze: 'aze', hy: 'hye', hye: 'hye', ka: 'kat', kat: 'kat',
  fa: 'per', per: 'per', sw: 'swa', zu: 'zul', zul: 'zul', af: 'afr', cy: 'wel', wel: 'wel',
  ga: 'gle', mt: 'mlt', lb: 'ltz', fo: 'fao', tt: 'tat', ba: 'bak', am: 'amh', so: 'som', ha: 'hau',
  ig: 'ibo', yo: 'yor', xh: 'xho', sq: 'sqi', sqi: 'sqi', alb: 'sqi', bs: 'bos', be: 'bel',
  dv: 'div', div: 'div', srd: 'srd', epo: 'epo', gsw: 'gsw', arc: 'arc', zxx: 'zxx',
  mul: 'mul', und: 'und',
};

/** The key a track and a setting are compared by. `zh-CN` and `chi` both answer `chi`; `pt-BR` answers
 *  `por`; a code no table knows answers itself. Null means «this track does not name a language». */
export const langKey = (raw?: string): string | null => {
  const code = (raw || '').trim().toLowerCase();
  if (!code) return null;
  const bare = code.split(/[-_]/)[0];
  if (!bare) return null;
  const key = ALIAS[bare] || bare;
  return key === 'und' || key === 'mul' || key === 'zxx' || key === 'def' || key === 'aud' || key === 'dol' ? null : key;
};

/** Which Chinese script a track is written in, when it says. The language field carries it on a locale
 *  (`zh-Hans`, `zh-TW`) or on the scene's own initialism (`chs`, `zht`, `sc`), and the title carries it in
 *  words on the bilingual releases whose two PGS tracks are both tagged `chi` — measured 2026-10-28 on
 *  挽救计划: one file, two 中文 PGS subtitles, 「简体」 and 「繁体」 in their names and nothing else to tell
 *  them apart. Both words present means the track carries both scripts, which is not an answer either, so
 *  it reads as «not said» and the tie falls to the other keys. */
export const scriptOf = (lang?: string, title?: string): 'hans' | 'hant' | null => {
  const tag = (lang || '').trim().toLowerCase();
  const locale = /^(?:zh|chi|zho)[-_]([a-z0-9]{2,4})/.exec(tag)?.[1];
  if (locale === 'hans' || locale === 'cn' || locale === 'sg') return 'hans';
  if (locale === 'hant' || locale === 'tw' || locale === 'hk' || locale === 'mo') return 'hant';
  if (tag === 'chs' || tag === 'zhs' || tag === 'sc') return 'hans';
  if (tag === 'zht' || tag === 'cht' || tag === 'tc') return 'hant';
  const t = title || '';
  const hans = /简体|简中|简英|简日|简韩|简繁|簡體|simplified|\bchs\b/i.test(t);
  const hant = /繁体|繁中|繁英|繁日|繁韩|简繁|繁體|traditional|\bcht\b/i.test(t);
  if (hans === hant) return null;
  return hans ? 'hans' : 'hant';
};

/** The answers 首选语言 offers: 媒体默认 (`''`, the file's own default — what mpv answers when nothing is
 *  asked for) and the four languages this library is actually in. The census of 2026-10-29 over 1,273 rows
 *  (`chi` 233, `spa` 134, `eng` 83, `por` 78, `jpn` 78 …) is what sets those four apart from the rest; a
 *  dialog of thirty rows exists to answer a question nobody here asks. A file in a language outside this list
 *  still plays and still names its track — the list only limits what can be *asked for*.
 */
export interface LangOption {
  value: string;
  label: string;
}

const CORE = ['chi', 'eng', 'jpn', 'kor'];

export const AUDIO_LANGS: LangOption[] = [
  { value: '', label: '媒体默认' },
  ...CORE.map(code => ({ value: code, label: langName(code) })),
];

/** The same list for subtitles, with the one distinction a single 「中文」 cannot make on a bilingual release
 *  (which script) in place of plain 中文, plus the answer only a subtitle can take: 关闭字幕. 关闭字幕 sits
 *  last because it is not a language — it is the row a viewer wants when the film is already in one they read. */
export const SUB_LANGS: LangOption[] = [
  { value: '', label: '媒体默认' },
  { value: 'chi-hans', label: '中文（简）' },
  { value: 'chi-hant', label: '中文（繁）' },
  ...CORE.filter(code => code !== 'chi').map(code => ({ value: code, label: langName(code) })),
  { value: 'none', label: '关闭字幕' },
];

const AUDIO_VALUES = new Set(AUDIO_LANGS.map(o => o.value));
const SUB_VALUES = new Set(SUB_LANGS.map(o => o.value));
/** A stored setting is only worth reading if the dialog can still print it: a hand-edited config saying
 *  `yuee` falls back to 媒体默认 rather than making the player silently pick nothing. */
export const isAudioLang = (v: unknown): v is string => typeof v === 'string' && AUDIO_VALUES.has(v);
export const isSubLang = (v: unknown): v is string => typeof v === 'string' && SUB_VALUES.has(v);

/** A setting read as the question the picker asks: which language, which script, and whether the answer is
 *  「no subtitles」. Null means nobody asked, so mpv keeps its own behaviour. */
export interface LangPref {
  key: string;
  script: 'hans' | 'hant' | null;
  off: boolean;
}

export const parseLangPref = (value?: string): LangPref | null => {
  const raw = (value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'none') return { key: '', script: null, off: true };
  const dash = raw.indexOf('-');
  const base = dash > 0 ? raw.slice(0, dash) : raw;
  const tail = dash > 0 ? raw.slice(dash + 1) : '';
  const key = langKey(base);
  if (!key) return null;
  const script = tail === 'hans' || tail === 'hant' ? tail : scriptOf(tail);
  return { key, script, off: false };
};
