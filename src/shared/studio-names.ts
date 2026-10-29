/** The name a company is actually called by, rather than the one on its business licence.
 *
 *  Two jobs live here, in this order.
 *
 *  1. 平台: Emby hands 公司 back exactly as the metadata provider spelled it, so the same streaming service
 *     arrives as 腾讯视频 on one title and Tencent Video on the next, 爱奇艺 as iQIYI or iQiyi. PLATFORM_ZH
 *     answers one question: when a row is a local service, what do we call it in Chinese. Foreign platforms
 *     (Netflix, Prime Video, Disney+) are absent on purpose and keep the server's spelling.
 *  2. 频道: the same TV station is credited once as "Beijing Television", once as "Beijing TV Station" and
 *     once as "Beijing Television 北京卫视". BROADCASTER_ZH answers the same question for channels: the label
 *     is the channel people name (北京卫视, 湖南卫视, 东方卫视), so every spelling lands on one row.
 *  3. 全名: film and TV companies are credited by their registered name — 北京乐开花影业有限公司,
 *     爱奇艺影业（北京）有限公司 — and nobody says that out loud. shorten() peels the legal form, the
 *     industry word and the city, in that order, until what is left is the 字号 (乐开花, 爱奇艺). It never
 *     invents a name: every step removes a suffix or prefix of the original, and when peeling would leave a
 *     generic word (卫视, 日报, 电影制片厂, 江西) or fewer than two characters, the last acceptable form
 *     stands.
 *
 *  Deliberately absent from PLATFORM_ZH: iQIYI Pictures / iQIYI Motion Pictures are production arms, not the
 *  service; WeTV is Tencent's overseas arm; TVB, Viu and ViuTV are Hong Kong/Taiwan broadcasters. */

const PLATFORM_ZH: Record<string, string> = {
  'iqiyi': '爱奇艺',
  'youku': '优酷',
  'youku inc.': '优酷',
  '优酷网': '优酷',
  'tencent video': '腾讯视频',
  '腾讯视频': '腾讯视频',
  'mango tv': '芒果TV',
  'mangotv': '芒果TV',
  'bilibili': '哔哩哔哩',
  'sohu video': '搜狐视频',
  'sohu': '搜狐视频',
  'migu video': '咪咕视频',
  'letv': '乐视视频',
  'xigua video': '西瓜视频',
  'cctv': '中国中央电视台',
  'china central television 中央电视台 (cctv)': '中国中央电视台',
};

/** 电视台: the same channel is credited once as "Beijing Television" and once as "Beijing Television 北京卫视",
 *  once as "Hunan TV" and once as "Hunan Satellite TV". All of them are one platform on screen, so they all
 *  answer the same name and the filter merges their ids into a single row. Japanese, Korean and European
 *  broadcasters are absent on purpose: they have no Chinese name and stay as the server spelled them. */
const BROADCASTER_ZH: Record<string, string> = {
  'beijing television': '北京卫视',
  'beijing tv': '北京卫视',
  'beijing tv station': '北京卫视',
  'hunan television': '湖南卫视',
  'hunan tv': '湖南卫视',
  'hunan satellite tv': '湖南卫视',
  'hunan broadcasting system': '湖南卫视',
  'jiangsu television': '江苏卫视',
  'jiangsu tv': '江苏卫视',
  'jiangsu broadcasting': '江苏卫视',
  'jiangxi television': '江西卫视',
  'jiangxi tv': '江西卫视',
  'zhejiang television': '浙江卫视',
  'zhejiang tv': '浙江卫视',
  'dragon television': '东方卫视',
  'dragon tv': '东方卫视',
  'anhui television': '安徽卫视',
  'anhui broadcasting corp.': '安徽卫视',
  'guangdong television': '广东卫视',
  'guangdong tv': '广东卫视',
  'guangxi television': '广西卫视',
  'shenzhen satellite tv': '深圳卫视',
  'tianjin television': '天津卫视',
  'tianjin tv': '天津卫视',
  'shandong television': '山东卫视',
  'sichuan television': '四川卫视',
  'henan television': '河南卫视',
  'hubei television': '湖北卫视',
  'chongqing television': '重庆卫视',
  'liaoning television': '辽宁卫视',
  'heilongjiang television': '黑龙江卫视',
  'yunnan television': '云南卫视',
  'guizhou television': '贵州卫视',
  'gansu television': '甘肃卫视',
  'xinjiang television': '新疆卫视',
  'shaanxi television': '陕西卫视',
  'jilin television': '吉林卫视',
  'hebei television': '河北卫视',
  'shanxi television': '山西卫视',
  'inner mongolia television': '内蒙古卫视',
  'nei mongol television': '内蒙古卫视',
  'shanghai media group': '上海广电',
  'china movie channel': '电影频道',
  'china movie channel (cmc)': '电影频道',
  'cctv-6 china movie channel 电影频道节目中心 (cmc)': '电影频道',
  'china network television': '中国网络电视台',
};

/* ---------------------------------------------------------------------------------------------
 * 4. 公司: the same company is credited by its registered English name on one title and by its Chinese
 *    name on the next — Bona Film Group here, 博纳影业 there, Wanda Pictures next to 万达影业. A row with no
 *    Chinese in it used to be read as foreign and kept as the server spelled it, which left most of the
 *    Chinese industry in English. COMPANY_ZH is the missing half: the name people actually say.
 *
 *    Only names that can be confirmed belong here. A guess is worse than the server's spelling — it invents
 *    a company. Japanese, Korean and Western houses are absent on purpose and keep their own name.
 * ------------------------------------------------------------------------------------------- */
const COMPANY_ZH: Record<string, string> = {
  'china film group corporation': '中国电影',
  'china film group': '中国电影',
  'china film': '中国电影',
  'china film creative': '中影创意',
  'china film co-production corp.': '中国电影合作制片公司',
  'china film co-production corporation': '中国电影合作制片公司',
  'china film co-production': '中国电影合作制片公司',
  'huaxia film distribution': '华夏电影',
  'bona film group': '博纳影业',
  'bona international film group': '博纳影业',
  'beijing bona cultural exchange co., ltd': '博纳影业',
  'wanda pictures': '万达',
  'beijing enlight pictures': '光线影业',
  'enlight pictures': '光线影业',
  'beijing enlight media': '光线传媒',
  'colorful enlight pictures': '彩条屋',
  'beijing coloroom technology': '彩条屋',
  'horgos coloroom pictures': '彩条屋',
  'huayi brothers pictures': '华谊兄弟',
  'huayi brothers advertising': '华谊兄弟',
  'huayi brothers international': '华谊兄弟',
  'huayi tencent entertainment company': '华谊腾讯',
  'perfect world pictures': '完美世界',
  'le vision pictures': '乐视影业',
  'alibaba pictures group': '阿里影业',
  'tencent pictures': '腾讯影业',
  'tencent penguin pictures': '腾讯影业',
  'tencent animation & comics': '腾讯动漫',
  'new classics media': '新丽传媒',
  'huace media': '华策',
  'huace film': '华策',
  'huace pictures': '华策',
  'lian ray pictures': '联瑞',
  'lianray pictures': '联瑞',
  'fun age pictures': '开心麻花',
  'beijing big bowl entertainment culture media': '大碗娱乐',
  'beijing bu yi le hu film company': '不亦乐乎影业',
  'huanxi media': '欢喜传媒',
  'huanxi media group': '欢喜传媒',
  'poly film investment': '保利',
  'sunac pictures': '融创影业',
  'evergrande pictures': '恒大影视',
  'suning universal': '苏宁环球',
  'stellar megamedia': '星美',
  'stellar mega films': '星美',
  'sparkle roll media': '耀莱影视',
  'huahua media': '华桦传媒',
  'hairun pictures company': '海润影业',
  'hairun pictures': '海润影业',
  'dmg entertainment': '印纪传媒',
  'beijing culture': '京西',
  'beijing ciwen digital oriental film & tv production co.': '慈文传媒',
  'daylight entertainment co., ltd.': '正午阳光',
  'china literature': '阅文',
  'shanghai yuewen': '阅文',
  'weibo corporation': '微博',
  'migu culture technology': '咪咕',
  'damai entertainment': '大麦',
  'maoyan entertainment': '猫眼',
  'tianjin maoyan media': '猫眼',
  'tianjin maoyan weiying culture media': '猫眼微影',
  'shanghai maoyan film': '猫眼',
  'tao piao piao': '淘票票',
  'shanghai tao piao piao movie & tv culture': '淘票票',
  'momo pictures': '陌陌',
  'china wit media': '微像',
  'yuuya midia': '有妖气',
  'light chaser animation studios': '追光动画',
  'october media': '十月文化',
  'october animation studio': '十月文化',
  'chengdu coco cartoon': '可可豆动画',
  'sparkly key animation studio': '玄机科技',
  'original force animation': '原力动画',
  'huaqiang fangte animation': '华强方特',
  'fantawild animation': '华强方特',
  'alpha group': '奥飞',
  'creative power entertaining': '原创动力',
  'winsing animation': '咏声动漫',
  'bad rabbit pictures': '坏兔子影业',
  'phoenix legend films': '凤凰传奇',
  'oriental dreamworks': '东方梦工厂',
  'beijing film studio': '北京电影制片厂',
  'shanghai film studio': '上海电影制片厂',
  'shanghai film group': '上海电影',
  'shanghai animation film studio': '上海美术电影制片厂',
  'changchun film studio': '长影',
  'emei film studio': '峨影',
  'guangxi film studio': '广西电影制片厂',
  "xi'an film studio": '西安电影制片厂',
  'tianjin film studio': '天津电影制片厂',
  'august 1st film studio': '八一电影制片厂',
  'ningxia film group': '宁夏电影集团',
  'yunnan film group': '云南电影集团',
  'chengdu film group': '成都电影集团',
  'chongoing film group': '重庆电影集团',
  'tianjin north film group': '北方电影',
  'shanxi film & television group': '山西影视集团',
  'shandong film & tv group': '山东影视集团',
  'zhejiang films & tv(group) company ltd.': '浙江影视',
  'henan film & tv production group': '河南电影',
  'he nan dian ying dian shi zhi zuo ji tuan': '河南电影',
  'wu zhou film distribution': '五洲电影发行',
  'zhujiang film group': '珠江电影',
  'dadi film group': '大地电影',
  'dadi film': '大地电影',
  'zhejiang hengdian film production': '横店影视',
  'hengdian chinese film production co.': '横店影视',
  'fujian hangye film distribution': '恒业',
  'beijing forbidden city film': '紫禁城影业',
  'beijing forbidden city film co., ltd.': '紫禁城影业',
  'beijing new picture film co. ltd.': '新画面',
  'beijing new picture film': '新画面',
  'shanghai new culture media group co ltd': '上海新文化',
  'shanghai east entertainment media group co., ltd': '上海东方娱乐传媒',
  'beijing fengxiaogang film & culture studio': '冯小刚工作室',
  'zhang yimou studio': '张艺谋工作室',
  'rao xiaozhi film studio': '饶晓志工作室',
  'guo fan culture and media': '郭帆文化',
  'pku starlight group': '北大星光',
  'taihe film investment': '太合',
  'arc light films': '弧光电影',
  'hua wen movie group': '华文',
  'guangzhou ying ming media co.': '英明',
  'beijing film academy': '北京电影学院',
  'orange sky golden harvest': '橙天嘉禾',
  'golden harvest productions': '嘉禾',
  'media asia films': '寰亚电影',
  'media asia film production': '寰亚电影',
  'sil-metropole organisation': '银都机构',
  'chengtian entertainment': '橙天娱乐',
  'emperor motion pictures': '英皇',
  'emperor entertainment group': '英皇',
  'emperor multimedia group': '英皇',
  'edko films': '安乐',
  'edko film': '安乐',
  'edko beijing films': '安乐',
  'golden princess film productions': '金公主',
  'cinema city': '新艺城',
  'milkyway image': '银河映像',
  'block 2 pictures': '泽东电影',
  'jet tone production': '泽东电影',
  'one cool films': '天下一',
  'sundream motion pictures': '骄阳电影',
  'universe films distribution': '寰宇',
  'universe films distribution company limited': '寰宇',
  'universe entertainment': '寰宇',
  'universe films ltd.': '寰宇',
  'universe entertainment limited': '寰宇',
  'jce movies': '寰宇',
  "win's movie productions": '永盛',
  "win's movie production limited": '永盛',
  "win's film co.": '永盛',
  "win's entertainment ltd.": '永盛',
  'd & b films': '德宝电影',
  'd & b film distribution (hong kong)': '德宝电影',
  'bo ho films': '宝禾',
  'mandarin films ltd.': '东方电影',
  'mandarin films': '东方电影',
  'mandarin motion pictures': '东方电影',
  'film workshop': '电影工作室',
  'long shong pictures': '龙祥',
  'mei ah films production': '美亚电影',
  'mei ah entertainment': '美亚娱乐',
  'celestial pictures': '天映娱乐',
  'tomson (hong kong) films co., ltd.': '汤臣电影',
  'lo wei motion picture company': '罗维影业',
  'shaw brothers': '邵氏',
  'distribution workshop': '发行工作室',
  'one hundred years of film company': '一百年电影',
  'sun entertainment culture': '太阳娱乐文化',
  'china star entertainment': '中国星',
  'china star entertainment group': '中国星',
  'china star movie limited': '中国星',
  'central motion picture corporation': '中央电影',
  'focus films limited': '映艺',
  'film development fund of hong kong': '香港电影发展基金',
  'film development fund of hk': '香港电影发展基金',
  'taipei film commission': '台北市电影委员会',
  'federation of hong kong filmmakers limited': '香港电影工作者总会',
  'hong kong stuntman association': '香港动作特技演员公会',
  "wong jing's workshop": '王晶工作室',
  'we pictures': '我们制作',
  'er dong pictures': '耳东影业',
};

/** Registered forms differ in the trailing legal words ("Co., Ltd.", "Corporation", "Group"), so the lookup
 *  runs on a form with the punctuation and those words taken out: "Beijing Forbidden City Film Co., Ltd."
 *  and "Beijing Forbidden City Film" are one company. */
const ENTITY_TAIL = /(?:^|\s)(?:co|ltd|limited|inc|incorporated|corp|corporation|llc|plc|group|holdings|holding|company)(?=\s|$)/g;
function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ')
    .replace(ENTITY_TAIL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const COMPANY_ZH_INDEX = new Map(Object.entries(COMPANY_ZH).map(([latin, zh]) => [companyKey(latin), zh]));

const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 一套 / 八套 / 十四套 — the way the channel is actually said out loud. */
function channelNumber(n: number): string {
  if (n < 10) return DIGITS[n];
  if (n < 20) return '十' + (n % 10 ? DIGITS[n % 10] : '');
  return String(n);
}

/** CCTV-8 and cctv 8 are the same channel; CCTV-6 has its own name (电影频道) but the channel number reads
 *  correctly either way, so the number wins and the rest of the row keeps whatever else it said. */
function cctvChannel(name: string): string | undefined {
  const m = /^cctv[-\s]?(\d{1,2})$/i.exec(name.trim());
  return m ? `央视${channelNumber(Number(m[1]))}套` : undefined;
}

const key = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

/* ---------------------------------------------------------------------------------------------
 * 全名 → 日常叫法
 *
 * The order matters and is the whole trick: a registered name layers the parts, outermost first —
 * 北京乐开花影业有限公司 = 城市 + 字号 + 行业 + 公司形式. Peel from the outside in and the 字号 (乐开花)
 * is what remains. Anything peeled must leave at least two characters, and must not leave a word that
 * cannot stand alone (卫视, 日报, 电影制片厂, 江西).
 * ------------------------------------------------------------------------------------------- */

/** 公司形式 — the part nobody says. */
const LEGAL = [
  '股份有限公司', '有限责任公司', '集团有限公司', '控股股份有限公司', '控股有限公司',
  '有限公司', '股份公司', '公司', '股份', '集团', '控股',
];

/** 行业 — what the company does, not who it is. Longest first so 影视文化传播 goes before 传播. */
const INDUSTRY = [
  '影视文化传播', '影视文化传媒', '文化投资管理', '国际影业投资', '国际传媒广告', '艺术文化传播',
  '影视文化', '文化传媒', '文化传播', '文化发展', '文化科技', '文化娱乐', '文化产业', '影视传媒',
  '影视制作', '影视投资', '电影文化', '电影发行', '电视制作', '节目制作', '数字动漫', '网络科技',
  '网络技术', '影业', '影视', '电影', '文化', '传媒', '传播', '娱乐', '科技', '网络', '技术',
  '投资', '管理', '咨询', '发展', '制作', '发行', '广告', '动漫', '映画', '映像', '影艺',
  '文创', '艺术', '音乐', '节目', '出版', '报业', '电视', '动画', '数字', '国际', '广电',
];

/** Words that describe a category rather than name a company; peeling down to one of these reads wrong. */
const STOP = new Set([
  '卫视', '日报', '电影', '电视', '影视', '影业', '文化', '传媒', '传播', '娱乐', '科技', '网络',
  '技术', '投资', '管理', '咨询', '发展', '制作', '发行', '广告', '集团', '控股', '股份', '公司',
  '市', '省', '数字', '动画', '动漫', '影艺', '文创', '艺术', '音乐', '节目', '出版', '报业',
  '映画', '映像', '电影制片厂', '电影频道', '文化传媒', '影视文化', '影视城', '央视', '广电',
  '电视台', '广播电视台', '广播影视集团', '广电集团', '影视集团',
]);

/** 省份与城市 the scanner puts in front of (or behind) a 字号. Either end is peeled, never the middle. */
const PLACES = [
  '内蒙古', '黑龙江', '北京', '上海', '天津', '重庆', '河北', '山西', '辽宁', '吉林', '江苏', '浙江',
  '安徽', '福建', '江西', '山东', '河南', '湖北', '湖南', '广东', '广西', '海南', '四川', '贵州',
  '云南', '陕西', '甘肃', '青海', '宁夏', '新疆', '西藏', '香港', '澳门', '台湾', '深圳', '广州',
  '杭州', '南京', '苏州', '成都', '武汉', '西安', '长沙', '厦门', '青岛', '宁波', '无锡', '昆山',
  '东阳', '横店', '霍尔果斯', '海口', '三亚', '平潭', '西咸新区', '温州', '湖州', '诸暨', '义乌',
  '佛山', '东莞', '常州', '南通', '徐州', '扬州', '绍兴', '金华', '台州', '嘉兴', '珠海', '中山',
  '惠州', '汕头', '湛江', '桂林', '南宁', '昆明', '贵阳', '兰州', '银川', '西宁', '乌鲁木齐',
  '呼和浩特', '沈阳', '大连', '长春', '哈尔滨', '济南', '烟台', '潍坊', '临沂', '郑州', '洛阳',
  '石家庄', '唐山', '保定', '太原', '合肥', '福州', '泉州', '南昌', '赣州', '株洲', '宜昌', '襄阳',
  '绵阳', '宜宾', '周庄',
];
const PLACE_SET = new Set(PLACES);
const PLACE_HEAD = PLACES.map((p) => new RegExp(`^${p}(?:市|省|自治区|特区)?`));
const PLACE_TAIL = PLACES.map((p) => new RegExp(`${p}(?:市|省|自治区|特区)?$`));

/** Names whose registered form is a genuinely different name, not a longer one. */
const OVERRIDE: Record<string, string> = {
  'china film 中国电影股份': '中国电影',
  'china film group（废弃）': '中国电影',
  'pearl river film group 珠江电影集团': '珠江电影',
  '珠江电影集团': '珠江电影',
  'warner china film hg corporation 中影华纳横店': '中影华纳横店',
  'youth film studio of beijing film academy 北京电影学院青年电影制片厂': '青年电影制片厂',
  'iqiyi pictures （重复 同 iqiyi motion pictures）': 'iQIYI Pictures',
  '温州市国际影视公司': '温州国际影视',
  '公安部金盾影视文化中心': '公安部金盾',
  'ministry of public security golden shield film and television culture center 公安部金盾影视文化中心': '公安部金盾',
  'beijing radio & television station 北京广播电视台 (brtv)': '北京广播电视台',
  '上海文化广播影视集团': '上海广电',
  'shanghai media group 上海文化广播影视集团 (smg)': '上海广电',
};

/** Traditional spellings the scanner mixes in; a 字号 should read the same either way. */
const TRAD: [string, string][] = [
  ['電影', '电影'], ['影業', '影业'], ['傳媒', '传媒'], ['傳播', '传播'], ['娛樂', '娱乐'],
  ['投資', '投资'], ['製作', '制作'], ['發行', '发行'], ['製片', '制片'],
];

/** A word that cannot carry a company name on its own: too short, a category word, or just a place —
 *  成都市 is a city, not a studio, and peeling to it was the one wrong answer the full library produced. */
function generic(s: string): boolean {
  const bare = s.replace(/(?:市|省|自治区|特区)$/, '');
  return s.length < 2 || STOP.has(s) || PLACE_SET.has(bare);
}

/** Drops [notes] and (parentheses) without leaving a gap behind: 爱奇艺影业（北京）有限公司 must become
 *  爱奇艺影业有限公司, not 爱奇艺影业 有限公司 — a space in the middle defeats every suffix test below. */
function clean(name: string): string {
  return name
    .replace(/^[.\u00b7\u30fb\u2022\s]+/, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[（(](?:集团|控股)[)）]/g, '')
    .replace(/[（(][^（）()]{1,12}[)）]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function peelLegal(s: string): string {
  for (let changed = true; changed; ) {
    changed = false;
    for (const w of LEGAL) {
      if (s.endsWith(w) && s.length - w.length >= 2) {
        s = s.slice(0, -w.length).trim();
        changed = true;
        break;
      }
    }
  }
  return s;
}

function peelIndustry(s: string): string {
  for (let changed = true; changed; ) {
    changed = false;
    for (const w of INDUSTRY) {
      const rest = s.slice(0, s.length - w.length).trim();
      if (s.endsWith(w) && !generic(rest)) {
        s = rest;
        changed = true;
        break;
      }
    }
  }
  return s;
}

function peelPlaces(s: string): string {
  let out = s;
  for (let pass = 0; pass < 3; pass++) {
    const head = PLACE_HEAD.find((re) => re.test(out) && !generic(out.replace(re, '').trim()));
    if (head) {
      out = out.replace(head, '').trim();
      continue;
    }
    const tail = PLACE_TAIL.find((re) => re.test(out) && !generic(out.replace(re, '').trim()));
    if (tail) {
      out = out.replace(tail, '').trim();
      continue;
    }
    break;
  }
  return out;
}

/** The 字号 of a Chinese company name: peel until nothing more can go, keep the shortest form that still
 *  reads as a name. */
function shortenCJK(raw: string): string {
  let s = clean(raw);
  for (const [a, b] of TRAD) s = s.split(a).join(b);
  if (!s) return raw.trim();
  let best = generic(s) ? '' : s;
  for (let i = 0; i < 4; i++) {
    const next = peelPlaces(peelIndustry(peelLegal(s)));
    if (next === s) break;
    s = next;
    if (!generic(s)) best = s;
  }
  return best || raw.trim();
}

const CJK = /[\u3400-\u9fff]/;
const LATIN = /[A-Za-z0-9)]/;

/** 腾讯视频 stays; 北京乐开花影业有限公司 becomes 乐开花; "Huace Pictures 华策影业" becomes 华策. A row with
 *  no Chinese in it is a foreign company and is left exactly as the server wrote it. */
function shorten(name: string): string {
  const override = OVERRIDE[key(name)];
  if (override) return override;
  const trimmed = name.trim();
  if (!CJK.test(trimmed)) return trimmed;
  let cjk = trimmed;
  if (/[A-Za-z]/.test(trimmed)) {
    // Bilingual rows credit the Latin name first and the Chinese one after it, so the tail is what people
    // say out loud. A handful put the Latin name last ("... 中国电视剧制作中心 (CTPC)"), where the tail is
    // empty — then the longest run of Chinese in the row is the name.
    let cut = -1;
    for (let i = 0; i < trimmed.length; i++) if (LATIN.test(trimmed[i])) cut = i;
    const tail = trimmed.slice(cut + 1).trim();
    cjk = CJK.test(tail) ? tail : (trimmed.match(/[\u3400-\u9fff][\u3400-\u9fff\s·・]*/g) || []).sort((a, b) => b.length - a.length)[0] || '';
  }
  if (!CJK.test(cjk)) return trimmed;
  const out = shortenCJK(cjk);
  return generic(out) ? trimmed : out;
}

/** The name of a company as people say it: the platform's Chinese name, the channel's Chinese name, or its
 *  字号. */
export function studioLabel(name: string): string {
  const cctv = cctvChannel(name);
  if (cctv) return cctv;
  const k = key(name);
  const broadcaster = BROADCASTER_ZH[k];
  if (broadcaster) return broadcaster;
  const platform = PLATFORM_ZH[k];
  if (platform) return platform;
  const company = COMPANY_ZH_INDEX.get(companyKey(name));
  if (company) return company;
  return shorten(name);
}

/** True when the label is the app's own naming rather than the server's, which is what the 公司 search box
 *  needs: someone who knows the service as Tencent Video should still find 腾讯视频, and someone who types
 *  有限公司 should still find the studio it belongs to. */
export function studioRenamed(name: string): boolean {
  return studioLabel(name) !== name;
}
